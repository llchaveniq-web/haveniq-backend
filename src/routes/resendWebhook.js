/**
 * POST /webhooks/resend — Resend bounce / complaint receiver.
 *
 * Without this, dead .edu addresses bounce silently and the user-row
 * stays "verified" forever. That pollutes match analytics and means
 * Cal Poly's `housing@calpoly.edu` complaining about deliverability
 * to alumni who left the school finds us with no internal record.
 *
 * Verifies the Svix-style HMAC signature Resend ships in
 *   svix-signature: t=<ts>,v1=<sha256>
 *
 * Public webhook. Auth header is the signature, not a JWT.
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const pool    = require('../db/pool');

const TIMESTAMP_TOLERANCE_S = 5 * 60;

function verify(req) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: 'no secret configured' };
  const sigHeader = req.get('svix-signature') || req.get('Resend-Signature');
  const tsHeader  = req.get('svix-timestamp') || req.get('Resend-Timestamp');
  const idHeader  = req.get('svix-id');
  if (!sigHeader || !tsHeader) return { ok: false, reason: 'missing signature headers' };

  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (drift > TIMESTAMP_TOLERANCE_S) return { ok: false, reason: 'timestamp drift' };

  // req.body must be the raw bytes — express.json() destroys this. We
  // mount this router with a per-route raw-body parser in server.js.
  const payload = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body);
  const toSign = `${idHeader || ''}.${ts}.${payload}`;

  // The header may include multiple v1=… entries separated by spaces.
  const signatures = sigHeader.split(/\s+/).filter(s => s.startsWith('v1='));
  const decodedSecret = Buffer.from(
    secret.replace(/^whsec_/, ''),
    'base64',
  );
  const expected = crypto
    .createHmac('sha256', decodedSecret)
    .update(toSign)
    .digest('base64');
  const ok = signatures.some(s => {
    const tail = s.slice(3);
    return tail.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(tail), Buffer.from(expected));
  });
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

router.post('/', async (req, res) => {
  const v = verify(req);
  if (!v.ok) {
    console.warn('[resend webhook] rejected:', v.reason);
    return res.status(401).json({ error: 'invalid signature' });
  }

  const evt = req.body;
  const type = evt?.type;
  const to = Array.isArray(evt?.data?.to) ? evt.data.to[0] : evt?.data?.to;
  if (!to || typeof to !== 'string') return res.json({ ok: true, skipped: 'no to' });
  const emailLower = to.trim().toLowerCase();

  // Delivery events are NOT just confirmation.
  //
  // That is what this comment used to say, and it is the assumption that made
  // the first real signup loss invisible. A student at LBCC asked for a code,
  // could not find it, and never came back. Nothing bounced, because nothing
  // failed: a message that lands in a university Junk folder is a DELIVERED
  // message. Recording the delivery is the only way to tell "Resend handed it
  // to the school and it is sitting in a filter" apart from "it never left",
  // and those two need completely different answers.
  if (type === 'email.delivered' || type === 'email.delivery_delayed') {
    const status = type === 'email.delivered' ? 'delivered' : 'delayed';
    try {
      // The newest unused signup code for that address: the one the student is
      // waiting on right now.
      await pool.query(
        `UPDATE otp_codes
            SET delivery_status = $1,
                delivered_at    = NOW()
          WHERE id = (
            SELECT id FROM otp_codes
             WHERE email = $2 AND purpose = 'signup' AND used = FALSE
             ORDER BY created_at DESC LIMIT 1
          )`,
        [status, emailLower],
      );
    } catch (err) {
      console.error('[resend webhook] delivery record failed:', err.message);
    }
  }

  // Hard bounce + complaint = flag user. Soft bounces are noise we don't act
  // on (Resend retries them automatically).
  if (type === 'email.bounced' || type === 'email.complained') {
    const reason = type === 'email.complained'
      ? 'spam complaint'
      : (evt?.data?.bounce?.subType || evt?.data?.bounce?.type || 'hard bounce');
    try {
      await pool.query(
        `UPDATE users
            SET email_undeliverable = TRUE,
                email_undeliverable_reason = $1
          WHERE LOWER(email) = $2`,
        [reason, emailLower],
      );

      // ALSO onto the code itself, because at signup there is no user row yet.
      //
      // This is how the first real signup was lost without a trace. The UPDATE
      // above is the only place a bounce was ever recorded, and it keys on
      // `users`. A student who asks for a verification code has no users row:
      // it is created at /verify-code, after the code is typed. So a hard
      // bounce on a VERIFICATION code, the one email whose failure ends the
      // funnel, updated zero rows and was discarded. Nothing was flagged,
      // nothing was logged, and send-code's own undeliverable check reads
      // `users`, so the next attempt sailed straight through and bounced again.
      //
      // Four codes went to two LBCC addresses. attempts = 0 on every one: he
      // never typed a digit, because nothing ever arrived. The system held no
      // record of that at all.
      const { rowCount } = await pool.query(
        `UPDATE otp_codes
            SET delivery_status = $1,
                delivered_at    = NOW()
          WHERE email = $2
            AND created_at > NOW() - INTERVAL '1 day'`,
        [reason === 'spam complaint' ? 'complained' : 'bounced', emailLower],
      );
      console.warn(`[resend webhook] flagged ${emailLower}: ${reason} (${rowCount} code row(s))`);
    } catch (err) {
      console.error('[resend webhook] DB update failed:', err.message);
    }
  }

  return res.json({ ok: true });
});

module.exports = router;
