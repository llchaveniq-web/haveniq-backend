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

// ── Static token auth ──────────────────────────────────────────────────

function requireBotToken(req, res, next) {
  const expected = process.env.ADMIN_BOT_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'Bot admin disabled (ADMIN_BOT_TOKEN not set).' });
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token !== expected) {
    return res.status(401).json({ error: 'Invalid bot token.' });
  }
  next();
}

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
// will eyeball each and call approve/reject. Caps at 50 per call.
router.get('/pending-signups', requireBotToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, email, school, first_name, last_name, photo_url, bio, age,
             school_domain, created_at, trust_score, quiz_completed,
             identity_verified_at, school_year, major
      FROM users
      WHERE is_verified = FALSE
        AND COALESCE(is_banned, FALSE) = FALSE
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
    res.json({ ok: true, acted });
  } catch (err) {
    console.error('[botAdmin] approve failed:', err);
    res.status(500).json({ error: 'Approve failed' });
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

module.exports = router;
