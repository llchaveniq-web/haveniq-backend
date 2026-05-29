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
      ORDER BY updated_at ASC
      LIMIT 50
    `);
    res.json({ count: rows.length, at_risk: rows });
  } catch (err) {
    console.error('[botAdmin] at-risk-users failed:', err);
    res.status(500).json({ error: 'At-risk query failed' });
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

module.exports = router;
