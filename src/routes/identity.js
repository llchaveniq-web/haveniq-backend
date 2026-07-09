// ─── Stripe Identity — government ID + selfie verification ────────────────
//
// Hosted-flow pattern: backend creates a VerificationSession with a
// `return_url` pointing back at our web app, returns the session URL.
// Frontend navigates the browser to that URL. Stripe renders their own
// camera + ID-upload + selfie-capture UI on stripe.com (handles all the
// device permissions and image quality). When the user finishes, Stripe
// redirects back to `return_url?vs={session_id}`. Stripe also fires
// webhooks (handled below) to keep our server-side status authoritative.
//
// We never see the actual ID image — Stripe stores those, encrypted, and
// only returns "verified | processing | requires_input | canceled".

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const stripeUtil = require('../utils/stripe');
const { audit } = require('../services/auditLog');
const analytics = require('../services/analytics');

// The URL the user is bounced back to after Stripe finishes. The path
// matters — our frontend reads it to know to refetch status.
const RETURN_PATH = '/government-id-verify?from=stripe';
const CLIENT_BASE = (process.env.CLIENT_URL || '').split(',')[0].trim() || 'https://app.haveniq.org';

function requireStripe(res) {
  const stripe = stripeUtil.tryInit();
  if (!stripe) {
    res.status(503).json({ error: 'ID verification is temporarily unavailable. Please try again later.' });
    return null;
  }
  return stripe;
}

// ── POST /identity/start ─────────────────────────────────────────────────
// Creates a fresh VerificationSession and returns the hosted URL.
// Idempotency: a user can have multiple sessions over time (e.g. they
// canceled the first one). We don't try to reuse old sessions — Stripe
// recommends a fresh one per attempt.
router.post('/start', requireAuth, async (req, res) => {
  const stripe = requireStripe(res);
  if (!stripe) return;
  try {
    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: {
        user_id: String(req.user.id),
      },
      options: {
        document: {
          // Require a selfie that matches the ID photo. This is the
          // Trust & Safety bar — not just "ID exists" but "you are the
          // person on the ID."
          require_matching_selfie: true,
          // Live photo only — no scan-a-photo-of-a-photo trick.
          require_live_capture:    true,
        },
      },
      return_url: `${CLIENT_BASE}${RETURN_PATH}`,
    });

    await pool.query(
      `INSERT INTO identity_verifications (user_id, stripe_session_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (stripe_session_id) DO UPDATE
         SET status = EXCLUDED.status, updated_at = NOW()`,
      [req.user.id, session.id, session.status],
    );

    audit(req, 'identity.start', { sessionId: session.id }).catch(() => {});
    res.json({ url: session.url, sessionId: session.id, status: session.status });
  } catch (err) {
    console.error('[identity/start] failed:', err?.message);
    res.status(500).json({ error: 'Could not start ID verification.' });
  }
});

// ── GET /identity/status ─────────────────────────────────────────────────
// Returns the user's most recent verification record. Frontend polls this
// after returning from Stripe to detect when status flips to 'verified'.
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT stripe_session_id, status, last_error_code, created_at, updated_at
         FROM identity_verifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.user.id],
    );
    if (rows.length === 0) return res.json({ status: 'none' });
    res.json({
      status:        rows[0].status,
      sessionId:     rows[0].stripe_session_id,
      lastErrorCode: rows[0].last_error_code,
      verifiedAt:    rows[0].status === 'verified' ? rows[0].updated_at : null,
    });
  } catch (err) {
    console.error('[identity/status] failed:', err?.message);
    res.status(500).json({ error: 'Could not check verification status.' });
  }
});

// ── POST /identity/refresh ───────────────────────────────────────────────
// When the user comes back from Stripe, we proactively pull the latest
// status from Stripe (rather than waiting for the webhook). This makes
// the UX feel instant even if the webhook is delayed by a few seconds.
router.post('/refresh', requireAuth, async (req, res) => {
  const stripe = requireStripe(res);
  if (!stripe) return;
  try {
    const { rows } = await pool.query(
      `SELECT stripe_session_id FROM identity_verifications
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.user.id],
    );
    if (rows.length === 0) return res.json({ status: 'none' });

    const session = await stripe.identity.verificationSessions.retrieve(rows[0].stripe_session_id);
    const { rows: prev } = await pool.query(
      `SELECT status FROM identity_verifications WHERE stripe_session_id = $1`,
      [session.id],
    );
    await pool.query(
      `UPDATE identity_verifications
         SET status = $1,
             last_error_code = $2,
             updated_at = NOW()
       WHERE stripe_session_id = $3`,
      [session.status, session.last_error?.code ?? null, session.id],
    );
    // Only fire on the transition into verified — avoid double-counting
    // a user refreshing the screen multiple times after success. We also
    // stamp `users.identity_verified_at` on the same transition so match
    // cards + the verified-badge UI can read straight from the user row
    // without joining identity_verifications on every read.
    if (session.status === 'verified' && prev[0]?.status !== 'verified') {
      await pool.query(
        `UPDATE users SET identity_verified_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND identity_verified_at IS NULL`,
        [req.user.id],
      );
      analytics.track(analytics.EVENTS.identity_verified, req.user.id);
    }
    res.json({
      status:        session.status,
      sessionId:     session.id,
      lastErrorCode: session.last_error?.code ?? null,
    });
  } catch (err) {
    console.error('[identity/refresh] failed:', err?.message);
    res.status(500).json({ error: 'Could not refresh verification status.' });
  }
});

// ── POST /identity/webhook ───────────────────────────────────────────────
// Stripe posts events here for identity.verification_session.* state
// changes. We update our DB to keep the user's "verified" flag fresh
// without making them refresh the screen. Signature verification uses
// STRIPE_WEBHOOK_SECRET; if not set we still accept the event but log it.
//
// IMPORTANT: server.js mounts express.json globally, but webhooks need
// the RAW body for signature verification. We use req.rawBody (captured
// by the json parser's `verify` hook in server.js).
router.post('/webhook', async (req, res) => {
  const stripe = stripeUtil.tryInit();
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (stripe && secret && sig && req.rawBody) {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
    } else if (process.env.NODE_ENV === 'production') {
      // Production NEVER trusts an unsigned body. Without this guard, a forged
      // `identity.verification_session.verified` event would flip a row to
      // verified and defeat the share-contact anti-scam gate that depends on
      // identity_verified_at. Refuse rather than trust — mirrors how the
      // premium webhook 503s when its signing secret is unconfigured.
      console.error('[identity/webhook] refused: cannot verify signature in production (set STRIPE_IDENTITY_WEBHOOK_SECRET).');
      return res.status(503).json({ error: 'Webhook signature verification unavailable' });
    } else {
      // Sandbox / dev only: trust the body so local testing works.
      event = req.body;
      console.warn('[identity/webhook] no signature verification (sandbox / non-production)');
    }
  } catch (err) {
    console.error('[identity/webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    const t = event?.type ?? '';
    if (t.startsWith('identity.verification_session.')) {
      const obj = event.data?.object || {};
      if (obj.id) {
        // Look up the prior status + user to fire identity_verified
        // exactly once on the verified-state transition.
        const { rows: prev } = await pool.query(
          `SELECT status, user_id FROM identity_verifications
            WHERE stripe_session_id = $1`,
          [obj.id],
        );
        await pool.query(
          `UPDATE identity_verifications
             SET status = $1,
                 last_error_code = $2,
                 updated_at = NOW()
           WHERE stripe_session_id = $3`,
          [obj.status, obj.last_error?.code ?? null, obj.id],
        );
        if (obj.status === 'verified' && prev[0] && prev[0].status !== 'verified') {
          // Promote the verified status onto the users row so match cards
          // can show "ID ✓" without joining identity_verifications. Idempotent
          // — only stamps if the column is still NULL.
          await pool.query(
            `UPDATE users SET identity_verified_at = NOW(), updated_at = NOW()
              WHERE id = $1 AND identity_verified_at IS NULL`,
            [prev[0].user_id],
          );
          analytics.track(analytics.EVENTS.identity_verified, prev[0].user_id);
        }
      }
      console.log(`[identity/webhook] ${t} → ${obj.id} = ${obj.status}`);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[identity/webhook] handler failed:', err.message);
    // Always 200 to Stripe to avoid retry loops on our bugs.
    res.json({ received: true });
  }
});

module.exports = router;
