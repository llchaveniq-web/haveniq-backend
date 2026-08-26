/**
 * Bot-admin routes — narrow, static-token-authed endpoints for the
 * automation bots (signup auto-review, weekly digest, support triage).
 *
 * Separate from /admin (which uses founder JWT) so the bots don't
 * need to mint or refresh user tokens. The static token is set via
 * env var ADMIN_BOT_TOKEN and stored in GitHub Actions secrets as
 * HAVENIQ_ADMIN_TOKEN. Rotating it: change Railway + the GitHub secret;
 * both in 30 seconds.
 *
 * What this CAN do:
 *   • Read the pending-signup queue
 *   • Approve / reject specific signups
 *   • Read aggregate metrics for the weekly digest
 *
 * What this CAN'T do:
 *   • Look up a specific user by anything other than user_id
 *   • Read messages, photos, quiz answers
 *   • Touch payments, scoring, matching, or safety reports
 *
 * Every action is logged to a `bot_admin_audit` table (created on demand)
 * so a misbehaving bot can be reconstructed and reversed.
 */

const router = require('express').Router();
const pool   = require('../db/pool');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// Demo / test accounts must NEVER receive a bot-drafted email or count as a
// real signup to triage. Two flavors exist in production:
//   • @haveniq-demo.edu  — the seeded demo cohort (admin.js generator); this
//                          is the domain the rest of the codebase filters on.
//   • @demo.haveniq.app  — the founder's manual test signups made through the
//                          real flow. These live only in the DB (no source
//                          reference) so the standard @haveniq-demo.edu filter
//                          misses them — which is how they leaked into the
//                          retention re-engagement drafts.
// Pass the column reference (e.g. 'email' or 'u.email'). Now shared with the
// rest of the codebase so the two-domain rule can't drift apart again.
const { notDemo } = require('../lib/demoFilter');

// ── Static token auth ──────────────────────────────────────────────────

// The single shared internal guard (middleware/requireInternalKey.js). This
// file used to carry its own constant-time copy — correct, but a copy. Four
// OTHER route files carried a WEAKER copy that compared with `!==`, which is
// exactly what duplicating a security check leads to. One implementation now.
// Still accepts `Authorization: Bearer <ADMIN_BOT_TOKEN>` (what the live cron
// jobs and the Discord bot send) plus `X-Internal-Key: <INTERNAL_API_KEY>`.
const { requireInternalKey: requireBotToken, constantTimeEqual } = require('../middleware/botAuth');

// Ensure audit table exists. Best-effort; we don't fail the request if
// the CREATE fails — only the audit insert downstream would silently
// no-op. Logged once at module load.
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_admin_audit (
        id         BIGSERIAL PRIMARY KEY,
        bot_name   TEXT NOT NULL,
        action     TEXT NOT NULL,
        target_id  TEXT,
        payload    JSONB,
        result     TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Speeds up the "has this signup already been escalated?" lookup that
    // pending-signups now does on every run.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS bot_admin_audit_lookup_idx
        ON bot_admin_audit (bot_name, action, target_id, created_at);
    `);
  } catch (err) {
    console.error('[botAdmin] audit table init failed:', err.message);
  }
})();

async function audit(botName, action, targetId, payload, result) {
  try {
    await pool.query(
      'INSERT INTO bot_admin_audit (bot_name, action, target_id, payload, result) VALUES ($1,$2,$3,$4,$5)',
      [botName, action, targetId ?? null, payload ? JSON.stringify(payload) : null, result ?? null],
    );
  } catch (err) {
    console.error('[botAdmin] audit write failed:', err.message);
  }
}

// ── GET /bot-admin/pending-signups ─────────────────────────────────────
// Returns users not yet verified and not banned, oldest first. The bot
// will eyeball each and call approve/reject/escalate. Caps at 50 per call.
//
// Escalation de-dup: a signup the bot punts to a human (escalate) is NOT
// approved or banned, so it would otherwise reappear in this queue every
// hourly run and re-escalate forever (this is exactly what happened with
// the incomplete Orange Coast College signup). We suppress any row that has
// already been escalated, UNLESS the user has touched their profile since
// (updated_at moves past the escalate audit row) — a profile change is new
// signal worth a fresh look. So: escalate once, go quiet, re-surface only
// if something actually changes.
router.get('/pending-signups', requireBotToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, email, school, first_name, last_name, photo_url, bio, age,
             school_domain, created_at, trust_score, quiz_completed,
             identity_verified_at, school_year, major
      FROM users u
      WHERE is_verified = FALSE
        AND COALESCE(is_banned, FALSE) = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM bot_admin_audit a
          WHERE a.bot_name   = 'signup-review'
            AND a.action     = 'escalate'
            AND a.target_id  = u.id::text
            AND a.created_at >= u.updated_at
        )
      ORDER BY created_at ASC
      LIMIT 50
    `);
    res.json({ count: rows.length, signups: rows });
  } catch (err) {
    console.error('[botAdmin] pending-signups failed:', err);
    res.status(500).json({ error: 'Query failed' });
  }
});

// ── POST /bot-admin/signup/:userId/approve ─────────────────────────────
router.post('/signup/:userId/approve', requireBotToken, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body || {};
  try {
    const r = await pool.query(
      'UPDATE users SET is_verified = TRUE, updated_at = NOW() WHERE id = $1 AND is_verified = FALSE RETURNING id',
      [userId],
    );
    const acted = r.rows.length > 0;
    await audit('signup-review', 'approve', userId, { reason: reason ?? null }, acted ? 'updated' : 'noop');
    // scoreNewMatches skips unverified submitters entirely, so an account
    // that finished the quiz BEFORE being approved would otherwise sit with
    // zero compatibility_scores rows forever — nothing re-triggers scoring
    // for them on its own. Score them now if they've completed the quiz.
    // Best-effort: a scoring failure shouldn't fail the approval itself.
    if (acted) {
      try {
        const { rows: qa } = await pool.query(
          'SELECT answers FROM quiz_answers WHERE user_id = $1 AND completed = TRUE LIMIT 1',
          [userId],
        );
        if (qa[0]) {
          const { scoreNewMatches } = require('./quiz');
          await scoreNewMatches(userId, qa[0].answers);
        }
      } catch (err) {
        console.error('[botAdmin] post-approve scoring failed:', err.message);
      }
    }
    res.json({ ok: true, acted });
  } catch (err) {
    console.error('[botAdmin] approve failed:', err);
    res.status(500).json({ error: 'Approve failed' });
  }
});

// -- GET /bot-admin/pending-listings ------------------------------------
// Listings waiting on a human. Returns the SIGNALS behind the score, not just
// the number: a reviewer needs to know which rule fired to tell a real concern
// from a phrasing coincidence.
router.get('/pending-listings', requireBotToken, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const { rows } = await pool.query(`
      SELECT id, address, city, school_near, beds, baths,
             per_person_rent_cents, total_rent_cents, photo_url,
             contact_name, contact_email,
             notes, created_at, created_by, risk_score, risk_signals,
             source, source_url
      FROM listings
      WHERE moderation_status = 'pending'
        AND ($1::text IS NULL OR source IS NOT DISTINCT FROM $1)
      ORDER BY risk_score DESC NULLS LAST, created_at ASC
      LIMIT $2 OFFSET $3
    `, [req.query.source || null, limit, offset]);

    // The whole queue, not just this page. A reviewer working through 500
    // listings needs to know how many are left and how many are flagged,
    // and a per-page count answers neither.
    const { rows: [tally] } = await pool.query(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE risk_score >= 50)::int flagged,
             count(*) FILTER (WHERE risk_score <  50 OR risk_score IS NULL)::int clean
        FROM listings
       WHERE moderation_status = 'pending'
         AND ($1::text IS NULL OR source IS NOT DISTINCT FROM $1)
    `, [req.query.source || null]);

    res.json({
      count: rows.length,
      pending: tally,
      listings: rows.map(r => ({
        ...r,
        perPerson: r.per_person_rent_cents == null ? null : r.per_person_rent_cents / 100,
        total: r.total_rent_cents == null ? null : r.total_rent_cents / 100,
      })),
    });
  } catch (err) {
    console.error('[botAdmin] pending-listings failed:', err);
    res.status(500).json({ error: 'Query failed' });
  }
});

// -- POST /bot-admin/listing/:id/approve ---------------------------------
// Guarded on moderation_status = 'pending', so a double-submitted approval is
// a no-op rather than silently re-publishing something a second reviewer had
// already rejected.
router.post('/listing/:id/approve', requireBotToken, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE listings
          SET moderation_status = 'approved', reviewed_at = NOW(), review_note = $2
        WHERE id = $1 AND moderation_status = 'pending'
        RETURNING id`,
      [id, reason ?? null],
    );
    const acted = r.rows.length > 0;
    await audit('listing-review', 'approve', id, { reason: reason ?? null }, acted ? 'updated' : 'noop');
    res.json({ ok: true, acted });
  } catch (err) {
    console.error('[botAdmin] listing approve failed:', err);
    res.status(500).json({ error: 'Approve failed' });
  }
});

// -- POST /bot-admin/listing/:id/reject ----------------------------------
// Rejection is NOT a delete. The row stays so a pattern of similar rejected
// listings remains queryable -- the same reasoning as roommate_safety_reports:
// the second attempt from a source is only visible if the first was kept.
router.post('/listing/:id/reject', requireBotToken, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE listings
          SET moderation_status = 'rejected', is_active = FALSE,
              reviewed_at = NOW(), review_note = $2
        WHERE id = $1 AND moderation_status <> 'rejected'
        RETURNING id`,
      [id, reason ?? null],
    );
    const acted = r.rows.length > 0;
    await audit('listing-review', 'reject', id, { reason: reason ?? null }, acted ? 'updated' : 'noop');
    res.json({ ok: true, acted });
  } catch (err) {
    console.error('[botAdmin] listing reject failed:', err);
    res.status(500).json({ error: 'Reject failed' });
  }
});

// -- GET /bot-admin/review ------------------------------------------------
// The moderation queue as a page a person can work through.
//
// Served WITHOUT the token, because a browser cannot set an Authorization
// header on a plain navigation. That is safe only because the shell contains no
// data: it is markup and script, and every byte of listing data behind it comes
// from the token-gated JSON endpoints the page calls after the reviewer pastes
// the token in. The alternative — a token in the query string — would put a
// long-lived admin credential into browser history, server logs and any
// referrer header the page emits, which is a worse trade than serving an empty
// page to whoever asks.
const readView = (name) => {
  try { return fs.readFileSync(path.join(__dirname, '../views/', name), 'utf8'); }
  catch (err) { console.error('[botAdmin] view missing:', name, err.message); return null; }
};
const REVIEW_PAGE = readView('review.html');
const REVIEW_JS   = readView('review.js');

// The app-wide policy is `script-src 'self'; script-src-attr 'none';
// img-src 'self' data:`. Two consequences this page has to live with:
//
//   1. Inline <script> and inline onclick are both refused, silently. The first
//      version of this page rendered perfectly and did nothing whatsoever —
//      every handler was blocked and nothing said so. Behaviour therefore lives
//      in review.js, served from this same origin.
//   2. img-src would block the listing photos, which come from Craigslist and
//      Uloop. A queue of text rows is not reviewable — the photo is the fastest
//      tell for a scam or a mismatched unit — so this ONE route widens img-src
//      to https:, and nothing else. Scripts stay 'self', object-src stays none,
//      and framing is denied outright since an admin page has no business in
//      anyone's iframe.
const REVIEW_CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

router.get('/review', (_req, res) => {
  if (!REVIEW_PAGE) return res.status(500).send('review page unavailable');
  res.set('Content-Security-Policy', REVIEW_CSP);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  res.send(REVIEW_PAGE);
});

router.get('/review.js', (_req, res) => {
  if (!REVIEW_JS) return res.status(500).send('// review script unavailable');
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  res.send(REVIEW_JS);
});

// -- POST /bot-admin/listings/bulk ---------------------------------------
// Approve or reject many listings in one call.
//
// This exists because the collector changed the shape of the problem. Reviewing
// one listing per HTTP request was fine when listings arrived a few a week from
// students; at 500 a day from two sources it is not review, it is a bottleneck
// that keeps the housing tab empty.
//
// What it deliberately does NOT do is approve by rule. There is no "approve
// everything under risk 50" endpoint, because that is a collector that
// publishes on its own wearing a thin disguise, and the promise on the landing
// page is that a human looked. Ids must be named explicitly by a caller that
// has them on screen; the review page selects them from what it just rendered.
//
// Capped per call so a malformed client cannot approve the entire queue in one
// request, and audited as a single row carrying every id — enough to reverse.
const BULK_MAX = 200;

router.post('/listings/bulk', requireBotToken, async (req, res) => {
  const { action, reason } = req.body || {};
  const raw = Array.isArray(req.body?.ids) ? req.body.ids : null;

  if (action !== 'approve' && action !== 'reject') {
    return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
  }
  if (!raw || !raw.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (raw.length > BULK_MAX) return res.status(400).json({ error: `at most ${BULK_MAX} ids per call` });

  // listings.id is a UUID. This validated "positive integer" and cast to
  // an integer array on the strength of an assumption about the schema, and
  // the tests confirmed that assumption because they stubbed the database with
  // integer ids — so the route could never have worked against the real table,
  // and the tests could never have noticed. Checked against information_schema.
  //
  // The whole batch is refused if any id is malformed, rather than the junk
  // being filtered out: a caller that sent three ids and sees two acted on
  // cannot tell which one it lost, or why.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = raw.map(v => (typeof v === 'string' ? v.trim() : ''));
  if (ids.some(v => !UUID_RE.test(v))) {
    return res.status(400).json({ error: 'every id must be a listing UUID' });
  }

  try {
    // Same guards as the single-listing routes: approving is only ever a
    // transition OUT of pending, so a double-submit is a no-op rather than
    // re-publishing something a second reviewer already rejected.
    const sql = action === 'approve'
      ? `UPDATE listings
            SET moderation_status = 'approved', reviewed_at = NOW(), review_note = $2
          WHERE id = ANY($1::uuid[]) AND moderation_status = 'pending'
          RETURNING id`
      : `UPDATE listings
            SET moderation_status = 'rejected', is_active = FALSE,
                reviewed_at = NOW(), review_note = $2
          WHERE id = ANY($1::uuid[]) AND moderation_status <> 'rejected'
          RETURNING id`;

    const { rows } = await pool.query(sql, [ids, reason ?? null]);
    const acted = rows.map(r => r.id);

    await audit('listing-review', `bulk-${action}`, null,
      { requested: ids, acted, reason: reason ?? null }, `${acted.length}/${ids.length}`);

    res.json({ ok: true, action, requested: ids.length, acted: acted.length, ids: acted });
  } catch (err) {
    console.error('[botAdmin] bulk listing review failed:', err);
    res.status(500).json({ error: 'Bulk review failed' });
  }
});

// ── POST /bot-admin/signup/:userId/reject ──────────────────────────────
router.post('/signup/:userId/reject', requireBotToken, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body || {};
  if (!reason || typeof reason !== 'string' || reason.length < 5) {
    return res.status(400).json({ error: 'Reason required (min 5 chars).' });
  }
  try {
    const r = await pool.query(
      `UPDATE users
       SET is_banned = TRUE, ban_reason = $2, banned_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND COALESCE(is_banned, FALSE) = FALSE
       RETURNING id`,
      [userId, `auto-rejected: ${reason.slice(0, 200)}`],
    );
    const acted = r.rows.length > 0;
    await audit('signup-review', 'reject', userId, { reason }, acted ? 'banned' : 'noop');
    res.json({ ok: true, acted });
  } catch (err) {
    console.error('[botAdmin] reject failed:', err);
    res.status(500).json({ error: 'Reject failed' });
  }
});

// ── POST /bot-admin/signup/:userId/escalate ────────────────────────────
// The bot couldn't safely auto-approve or auto-reject and is handing this
// signup to a human (via Discord). We record the handoff in the audit log
// WITHOUT changing the user row — that audit row is what pending-signups
// uses to stop re-surfacing this signup every hour. Idempotent and always
// succeeds: if the audit write fails, worst case the signup reappears next
// run (the old behavior), never worse.
router.post('/signup/:userId/escalate', requireBotToken, async (req, res) => {
  // Wrapped in try/catch like the sibling approve/reject handlers — without it,
  // a DB hiccup in audit() would leave this request hanging with no response
  // (unhandled async rejection). Low blast radius (bot-only), but every handler
  // should always answer.
  try {
    const { userId } = req.params;
    const { suggested_action, reason } = req.body || {};
    await audit(
      'signup-review', 'escalate', userId,
      { suggested_action: suggested_action ?? null, reason: reason ?? null },
      'escalated',
    );
    res.json({ ok: true, acted: true });
  } catch (e) {
    console.error('[bot-admin/escalate]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// ── GET /bot-admin/digest ──────────────────────────────────────────────
// Aggregate metrics for the weekly digest bot. Privacy: never returns
// individual user data — only counts and bucketed distributions.
router.get('/digest', requireBotToken, async (req, res) => {
  try {
    const since = "NOW() - INTERVAL '7 days'";
    const [signups, verifiedSignups, quizCompleted, matchesScored, conversationsStarted, pending, photoSet, bioSet] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE created_at > ${since}`),
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE is_verified = TRUE AND created_at > ${since}`),
      pool.query(`SELECT COUNT(*) AS n FROM quiz_answers WHERE completed = TRUE AND updated_at > ${since}`),
      pool.query(`SELECT COUNT(*) AS n FROM compatibility_scores WHERE created_at > ${since}`).catch(() => ({ rows: [{ n: 0 }] })),
      pool.query(`SELECT COUNT(*) AS n FROM conversations WHERE created_at > ${since}`).catch(() => ({ rows: [{ n: 0 }] })),
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE is_verified = FALSE AND COALESCE(is_banned, FALSE) = FALSE`),
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE photo_url IS NOT NULL AND created_at > ${since}`),
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE bio IS NOT NULL AND length(bio) > 20 AND created_at > ${since}`),
    ]);
    res.json({
      last_7_days: {
        signups:                Number(signups.rows[0].n),
        verified_signups:       Number(verifiedSignups.rows[0].n),
        quiz_completions:       Number(quizCompleted.rows[0].n),
        matches_scored:         Number(matchesScored.rows[0].n),
        conversations_started:  Number(conversationsStarted.rows[0].n),
        photo_added:            Number(photoSet.rows[0].n),
        bio_added:              Number(bioSet.rows[0].n),
      },
      pending_signups: Number(pending.rows[0].n),
    });
  } catch (err) {
    console.error('[botAdmin] digest failed:', err);
    res.status(500).json({ error: 'Digest failed' });
  }
});

// ── GET /bot-admin/recent-content ──────────────────────────────────────
// Returns bios + free-text quiz writing samples updated since the
// `since` query param (ISO timestamp). Used by the text-moderation bot
// to scan new user-generated content. Cap 100 records per call.
router.get('/recent-content', requireBotToken, async (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const [bios, samples] = await Promise.all([
      pool.query(`
        SELECT id, email, school, first_name, bio, updated_at
        FROM users
        WHERE bio IS NOT NULL AND length(trim(bio)) > 0
          AND updated_at > $1
          AND COALESCE(is_banned, FALSE) = FALSE
        ORDER BY updated_at ASC
        LIMIT 100
      `, [since]),
      pool.query(`
        SELECT u.id AS user_id, u.email, u.first_name, u.school,
               qa.writing_sample, qa.updated_at
        FROM quiz_answers qa
        JOIN users u ON u.id = qa.user_id
        WHERE qa.writing_sample IS NOT NULL AND length(trim(qa.writing_sample)) > 0
          AND qa.updated_at > $1
          AND COALESCE(u.is_banned, FALSE) = FALSE
        ORDER BY qa.updated_at ASC
        LIMIT 100
      `, [since]).catch(() => ({ rows: [] })),
    ]);
    res.json({
      bios: bios.rows,
      writing_samples: samples.rows,
      latest_seen: Math.max(
        ...bios.rows.map(r => new Date(r.updated_at).getTime()),
        ...samples.rows.map(r => new Date(r.updated_at).getTime()),
        new Date(since).getTime(),
      ),
    });
  } catch (err) {
    console.error('[botAdmin] recent-content failed:', err);
    res.status(500).json({ error: 'Recent content failed' });
  }
});

// ── POST /bot-admin/user/:userId/blank-bio ────────────────────────────
// Used when the moderator classifies a bio as PII leak or spam — clears
// the field rather than banning, so the user can re-write. Audited.
router.post('/user/:userId/blank-bio', requireBotToken, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body || {};
  if (!reason || typeof reason !== 'string' || reason.length < 5) {
    return res.status(400).json({ error: 'Reason required (min 5 chars).' });
  }
  try {
    const r = await pool.query(
      'UPDATE users SET bio = NULL, updated_at = NOW() WHERE id = $1 RETURNING id',
      [userId],
    );
    const acted = r.rows.length > 0;
    await audit('content-moderation', 'blank-bio', userId, { reason }, acted ? 'blanked' : 'noop');
    res.json({ ok: true, acted });
  } catch (err) {
    console.error('[botAdmin] blank-bio failed:', err);
    res.status(500).json({ error: 'Blank bio failed' });
  }
});

// ── POST /bot-admin/user/:userId/blank-writing ────────────────────────
router.post('/user/:userId/blank-writing', requireBotToken, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body || {};
  if (!reason || typeof reason !== 'string' || reason.length < 5) {
    return res.status(400).json({ error: 'Reason required (min 5 chars).' });
  }
  try {
    const r = await pool.query(
      'UPDATE quiz_answers SET writing_sample = NULL, updated_at = NOW() WHERE user_id = $1 RETURNING user_id',
      [userId],
    );
    const acted = r.rows.length > 0;
    await audit('content-moderation', 'blank-writing-sample', userId, { reason }, acted ? 'blanked' : 'noop');
    res.json({ ok: true, acted });
  } catch (err) {
    console.error('[botAdmin] blank-writing failed:', err);
    res.status(500).json({ error: 'Blank writing failed' });
  }
});

// ── GET /bot-admin/pending-reports ─────────────────────────────────────
// Open user_reports with both sides' identity context. Caller (the
// safety-triage bot) will fetch the message thread separately if needed.
router.get('/pending-reports', requireBotToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        r.id, r.category, r.severity, r.reason, r.details, r.created_at,
        r.reporter_id, r.reported_id,
        reporter.email AS reporter_email, reporter.first_name AS reporter_first_name,
        reporter.school AS reporter_school, reporter.is_verified AS reporter_is_verified,
        reported.email AS reported_email, reported.first_name AS reported_first_name,
        reported.school AS reported_school, reported.is_verified AS reported_is_verified,
        reported.is_banned AS reported_is_banned, reported.trust_score AS reported_trust_score,
        reported.created_at AS reported_created_at
      FROM user_reports r
      LEFT JOIN users reporter ON reporter.id = r.reporter_id
      LEFT JOIN users reported ON reported.id = r.reported_id
      WHERE r.status = 'open'
      ORDER BY r.created_at ASC
      LIMIT 50
    `);
    res.json({ count: rows.length, reports: rows });
  } catch (err) {
    console.error('[botAdmin] pending-reports failed:', err);
    res.status(500).json({ error: 'Pending reports failed' });
  }
});

// ── POST /bot-admin/report/:id/dismiss ─────────────────────────────────
router.post('/report/:id/dismiss', requireBotToken, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || reason.length < 5) {
    return res.status(400).json({ error: 'Reason required (min 5 chars).' });
  }
  try {
    const r = await pool.query(`
      UPDATE user_reports
      SET status = 'dismissed', resolved_at = NOW(), resolved_note = $2
      WHERE id = $1 AND status = 'open'
      RETURNING id
    `, [req.params.id, `auto-dismissed: ${reason.slice(0, 200)}`]);
    const acted = r.rows.length > 0;
    await audit('safety-triage', 'dismiss', req.params.id, { reason }, acted ? 'dismissed' : 'noop');
    res.json({ ok: true, acted });
  } catch (err) {
    console.error('[botAdmin] dismiss failed:', err);
    res.status(500).json({ error: 'Dismiss failed' });
  }
});

// ── POST /bot-admin/report/:id/escalate ────────────────────────────────
// Bot couldn't safely auto-act. Marks the report as 'reviewed' (i.e. seen
// by automation but punted to human) and logs the bot's suggestion.
router.post('/report/:id/escalate', requireBotToken, async (req, res) => {
  const { suggested_action, reason } = req.body || {};
  if (!reason || reason.length < 5) {
    return res.status(400).json({ error: 'Reason required.' });
  }
  try {
    const note = `auto-triage suggests ${suggested_action || 'human review'}: ${reason.slice(0, 400)}`;
    const r = await pool.query(`
      UPDATE user_reports
      SET status = 'reviewed', resolved_note = $2
      WHERE id = $1 AND status = 'open'
      RETURNING id
    `, [req.params.id, note]);
    const acted = r.rows.length > 0;
    await audit('safety-triage', 'escalate', req.params.id, { suggested_action, reason }, acted ? 'escalated' : 'noop');
    res.json({ ok: true, acted });
  } catch (err) {
    console.error('[botAdmin] escalate failed:', err);
    res.status(500).json({ error: 'Escalate failed' });
  }
});

// ── GET /bot-admin/recent-scores ───────────────────────────────────────
// Recent compatibility_scores with both users' metadata for the match
// quality watchdog. Returns last 7 days, hard cap 200 rows.
router.get('/recent-scores', requireBotToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        cs.id, cs.user_a, cs.user_b, cs.score, cs.is_hard_blocked,
        cs.is_soft_blocked, cs.shadow_penalty, cs.breakdown,
        cs.calculated_at,
        a.school AS school_a, a.school_year AS school_year_a, a.gender AS gender_a,
        a.looking_for AS looking_for_a, a.age AS age_a,
        b.school AS school_b, b.school_year AS school_year_b, b.gender AS gender_b,
        b.looking_for AS looking_for_b, b.age AS age_b
      FROM compatibility_scores cs
      LEFT JOIN users a ON a.id = cs.user_a
      LEFT JOIN users b ON b.id = cs.user_b
      WHERE cs.calculated_at > NOW() - INTERVAL '7 days'
      AND a.email NOT LIKE '%@haveniq-demo.edu' AND a.email NOT LIKE '%@demo.haveniq.app'
      AND b.email NOT LIKE '%@haveniq-demo.edu' AND b.email NOT LIKE '%@demo.haveniq.app'
      ORDER BY cs.calculated_at DESC
      LIMIT 200
    `);
    res.json({ count: rows.length, scores: rows });
  } catch (err) {
    console.error('[botAdmin] recent-scores failed:', err);
    res.status(500).json({ error: 'Recent scores failed' });
  }
});

// ── GET /bot-admin/at-risk-users ───────────────────────────────────────
// Powers the retention re-engagement bot. Returns users who:
//   • signed up at least 14 days ago (had time to engage)
//   • haven't touched their profile in 7+ days (proxy for inactivity)
//   • haven't been banned or paused
// Capped at 50 per call. Includes enough context for Claude to draft
// a personalized nudge.
router.get('/at-risk-users', requireBotToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id, email, school, first_name, photo_url IS NOT NULL AS has_photo,
        bio IS NOT NULL AND length(trim(bio)) > 0 AS has_bio,
        quiz_completed, is_verified, school_year, major,
        created_at, updated_at,
        EXTRACT(DAY FROM NOW() - updated_at)::int AS days_since_active,
        EXTRACT(DAY FROM NOW() - created_at)::int AS days_since_signup
      FROM users
      WHERE updated_at < NOW() - INTERVAL '7 days'
        AND created_at  < NOW() - INTERVAL '14 days'
        AND COALESCE(is_banned, FALSE) = FALSE
        AND COALESCE(is_paused, FALSE) = FALSE
        AND ${notDemo('email')}
      ORDER BY updated_at ASC
      LIMIT 50
    `);
    res.json({ count: rows.length, at_risk: rows });
  } catch (err) {
    console.error('[botAdmin] at-risk-users failed:', err);
    res.status(500).json({ error: 'At-risk query failed' });
  }
});

// ── GET /bot-admin/matches-needing-survey ──────────────────────────────
// Powers the 30-day satisfaction-survey bot. Returns connect_requests
// where:
//   1. Status is 'accepted' (a real match — both sides opted in)
//   2. Accepted 25-35 days ago (target window: ~30-day check-in)
//   3. Neither party has logged a `survey_30d` match_outcome for
//      this pair yet (dedupe: don't survey twice)
//
// Why this window: at 30 days, matched pairs have either:
//   - Met in person and decided whether to actually room together
//   - Drifted apart (signal for matching algorithm)
//   - Still chatting and deliberating (real-time signal)
// All three are valuable data. Pre-30d is too early; post-60d is too
// late to capture freshness.
//
// Returns both sides' user info so Claude can personalize the email
// to each party separately (founder sends one email per person, not
// per pair — more authentic).
router.get('/matches-needing-survey', requireBotToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        cr.id                         AS request_id,
        cr.from_user                  AS user_a_id,
        cr.to_user                    AS user_b_id,
        cr.updated_at                 AS matched_at,
        EXTRACT(DAY FROM NOW() - cr.updated_at)::int AS days_since_match,
        a.email                       AS user_a_email,
        a.first_name                  AS user_a_first_name,
        a.school                      AS user_a_school,
        a.school_year                 AS user_a_school_year,
        b.email                       AS user_b_email,
        b.first_name                  AS user_b_first_name,
        b.school                      AS user_b_school,
        b.school_year                 AS user_b_school_year,
        -- Surface compat score if we have one so Claude can reference it
        (SELECT score FROM compatibility_scores cs
          WHERE (cs.user_a = LEAST(cr.from_user, cr.to_user)
            AND cs.user_b = GREATEST(cr.from_user, cr.to_user))
          LIMIT 1)                    AS match_score
      FROM connect_requests cr
      JOIN users a ON a.id = cr.from_user
      JOIN users b ON b.id = cr.to_user
      WHERE cr.status = 'accepted'
        AND cr.updated_at BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '25 days'
        AND NOT EXISTS (
          SELECT 1 FROM match_outcomes mo
          WHERE mo.outcome = 'survey_30d'
            AND (
              (mo.reporter_id = cr.from_user AND mo.other_user_id = cr.to_user)
              OR (mo.reporter_id = cr.to_user AND mo.other_user_id = cr.from_user)
            )
        )
        AND COALESCE(a.is_banned, FALSE) = FALSE
        AND COALESCE(b.is_banned, FALSE) = FALSE
        AND COALESCE(a.is_paused, FALSE) = FALSE
        AND COALESCE(b.is_paused, FALSE) = FALSE
        AND ${notDemo('a.email')}
        AND ${notDemo('b.email')}
      ORDER BY cr.updated_at ASC
      LIMIT 50
    `);
    res.json({ count: rows.length, matches: rows });
  } catch (err) {
    console.error('[botAdmin] matches-needing-survey failed:', err);
    res.status(500).json({ error: 'Survey query failed' });
  }
});

// ── GET /bot-admin/monthly-rollup ──────────────────────────────────────
// Powers the monthly investor-update bot. Aggregate metrics over the last
// 30 days plus the 30 days prior, so we can show month-over-month deltas.
router.get('/monthly-rollup', requireBotToken, async (req, res) => {
  try {
    const cur = "BETWEEN NOW() - INTERVAL '30 days' AND NOW()";
    const pre = "BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '30 days'";
    const Q = (col, where) => pool.query(`SELECT COUNT(*) AS n FROM ${col} WHERE ${where}`).catch(() => ({ rows: [{ n: 0 }] }));
    const [
      curSignups, curVerified, curQuiz, curConvo, curMatches,
      preSignups, preVerified, preQuiz, preConvo, preMatches,
      totalUsers, totalVerified, totalQuizDone,
    ] = await Promise.all([
      Q('users',                   `created_at ${cur}`),
      Q('users',                   `is_verified = TRUE AND created_at ${cur}`),
      Q('quiz_answers',            `completed = TRUE AND updated_at ${cur}`),
      Q('conversations',           `created_at ${cur}`),
      Q('compatibility_scores',    `calculated_at ${cur}`),
      Q('users',                   `created_at ${pre}`),
      Q('users',                   `is_verified = TRUE AND created_at ${pre}`),
      Q('quiz_answers',            `completed = TRUE AND updated_at ${pre}`),
      Q('conversations',           `created_at ${pre}`),
      Q('compatibility_scores',    `calculated_at ${pre}`),
      Q('users',                   `1 = 1`),
      Q('users',                   `is_verified = TRUE`),
      Q('quiz_answers',            `completed = TRUE`),
    ]);
    const n = (r) => Number(r.rows[0].n);
    res.json({
      current_30d: {
        signups: n(curSignups), verified_signups: n(curVerified),
        quiz_completions: n(curQuiz), conversations_started: n(curConvo),
        matches_scored: n(curMatches),
      },
      previous_30d: {
        signups: n(preSignups), verified_signups: n(preVerified),
        quiz_completions: n(preQuiz), conversations_started: n(preConvo),
        matches_scored: n(preMatches),
      },
      lifetime: {
        users: n(totalUsers), verified_users: n(totalVerified),
        quiz_completions: n(totalQuizDone),
      },
    });
  } catch (err) {
    console.error('[botAdmin] monthly-rollup failed:', err);
    res.status(500).json({ error: 'Monthly rollup failed' });
  }
});

// ── GET /bot-admin/quiz-dropoffs ───────────────────────────────────────
// Powers the quiz-dropoff recovery bot. Returns users who:
//   • answered at least 1 quiz question
//   • have NOT completed the quiz
//   • last quiz activity was 24h+ ago (gives them time to come back naturally)
//   • not banned, not paused, signed up at least 24h ago
// Capped at 30 per run. Includes the question they stopped at so
// Claude can craft a personal "checking in" note.
router.get('/quiz-dropoffs', requireBotToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH last_answer AS (
        SELECT
          user_id,
          MAX(created_at) AS last_answered_at,
          COUNT(*)        AS answered_count,
          MAX(question_id) AS last_question_id
        FROM quiz_answers
        GROUP BY user_id
      )
      SELECT
        u.id, u.email, u.first_name, u.school, u.school_year, u.major,
        u.created_at,
        la.answered_count,
        la.last_question_id,
        la.last_answered_at,
        EXTRACT(EPOCH FROM (NOW() - la.last_answered_at))::int / 3600 AS hours_since_last_answer,
        EXTRACT(EPOCH FROM (NOW() - u.created_at))::int / 86400        AS days_since_signup
      FROM users u
      JOIN last_answer la ON la.user_id = u.id
      WHERE
        u.created_at < NOW() - INTERVAL '24 hours'
        AND COALESCE(u.quiz_completed, FALSE) = FALSE
        AND COALESCE(u.is_banned,   FALSE) = FALSE
        AND COALESCE(u.is_paused,   FALSE) = FALSE
        AND ${notDemo('u.email')}
        AND la.last_answered_at < NOW() - INTERVAL '24 hours'
        AND la.last_answered_at > NOW() - INTERVAL '30 days'
      ORDER BY la.last_answered_at DESC
      LIMIT 30
    `).catch((e) => {
      // If quiz_answers table or its columns don't exist yet, return empty
      // instead of 500. The bot still runs and posts a healthy heartbeat.
      console.warn('[botAdmin] quiz-dropoffs query soft-failed:', e.message);
      return { rows: [] };
    });
    res.json({ count: rows.length, dropoffs: rows });
  } catch (err) {
    console.error('[botAdmin] quiz-dropoffs failed:', err);
    res.status(500).json({ error: 'Quiz dropoffs query failed' });
  }
});

// ── GET /bot-admin/match-diagnostics ───────────────────────────────────
// Per-account matching health, for diagnosing "I finished the quiz but have
// no matches". For each real (non-demo) user it reports the two completion
// flags that can silently disagree (users.quiz_completed vs
// quiz_answers.completed — the matcher keys off the LATTER), whether the
// account is paused (paused users are invisible to everyone else's scoring),
// whether a personality profile exists, and how many compatibility_scores
// rows the account has. An account that is answers_completed = true but has
// score_rows = 0 is the smoking gun: it finished the quiz but was never
// scored against anyone (e.g. it completed before any other user existed and
// no later submit re-scored it). Read-only.
router.get('/match-diagnostics', requireBotToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id, u.email, u.school,
        COALESCE(u.is_paused, FALSE)        AS is_paused,
        COALESCE(u.quiz_completed, FALSE)   AS users_quiz_completed,
        (qa.completed IS TRUE)              AS answers_completed,
        (pp.user_id IS NOT NULL)            AS has_personality,
        (SELECT COUNT(*) FROM compatibility_scores cs
           WHERE cs.user_a = u.id OR cs.user_b = u.id)            AS score_rows,
        (SELECT COUNT(*) FROM compatibility_scores cs
           WHERE (cs.user_a = u.id OR cs.user_b = u.id)
             AND cs.is_hard_blocked = FALSE AND cs.score >= 50)   AS feedable_rows,
        u.created_at
      FROM users u
      LEFT JOIN quiz_answers qa        ON qa.user_id = u.id
      LEFT JOIN personality_profiles pp ON pp.user_id = u.id
      WHERE COALESCE(u.is_banned, FALSE) = FALSE
        AND ${notDemo('u.email')}
      ORDER BY u.created_at DESC
      LIMIT 100
    `);
    res.json({ count: rows.length, accounts: rows });
  } catch (err) {
    console.error('[botAdmin] match-diagnostics failed:', err);
    res.status(500).json({ error: 'Diagnostics failed' });
  }
});

// ── POST /bot-admin/recompute-matches ──────────────────────────────────
// Regenerates every compatibility_scores row by re-running the live scoring
// for each completed user. Idempotent (upserts). Repairs accounts that
// finished the quiz but never got scored. Uses the SAME scoreNewMatches the
// quiz-submit path uses (exported from routes/quiz), so there is no chance of
// the recompute drifting from live behavior.
router.post('/recompute-matches', requireBotToken, async (req, res) => {
  try {
    const { recomputeAllMatches } = require('./quiz');
    const summary = await recomputeAllMatches();
    await audit('match-recompute', 'recompute', null, summary, 'recomputed');
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[botAdmin] recompute-matches failed:', err);
    res.status(500).json({ error: 'Recompute failed' });
  }
});

// ── POST /bot-admin/heal-personalities ─────────────────────────────────
// Repairs completed-quiz users left with NO personality_profiles row (a lost
// derivation → clinical-only, degraded matches). Re-derives + re-scores them,
// bounded per run so a backlog can't spike Anthropic cost. Same function the
// server's self-heal interval runs, so a cron and the loop stay in sync.
router.post('/heal-personalities', requireBotToken, async (req, res) => {
  try {
    const { healMissingPersonalities } = require('./quiz');
    const limit = Math.min(100, Math.max(1, parseInt(req.body?.limit, 10) || 25));
    const summary = await healMissingPersonalities({ limit });
    await audit('match-recompute', 'heal-personalities', null, summary, 'healed');
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[botAdmin] heal-personalities failed:', err);
    res.status(500).json({ error: 'Heal failed' });
  }
});

// ── POST /bot-admin/clear-blocks ───────────────────────────────────────
// Support/admin tool: remove ALL user_blocks involving one account (both
// directions). Built for the case where a tester swiped left on their only
// candidate — which (before the pass/block fix) created a permanent block
// and emptied their feed. Body: { email }. Returns how many block rows were
// removed. Audited.
router.post('/clear-blocks', requireBotToken, async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email required' });
  }
  try {
    const { rows: u } = await pool.query(
      'SELECT id FROM users WHERE lower(email) = lower($1)', [email],
    );
    if (!u[0]) return res.status(404).json({ error: 'user not found' });
    const uid = u[0].id;
    const r = await pool.query(
      'DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1',
      [uid],
    );
    await audit('match-recompute', 'clear-blocks', uid, { email, removed: r.rowCount }, 'cleared');
    res.json({ ok: true, email, removed: r.rowCount });
  } catch (err) {
    console.error('[botAdmin] clear-blocks failed:', err);
    res.status(500).json({ error: 'Clear blocks failed' });
  }
});

module.exports = router;
