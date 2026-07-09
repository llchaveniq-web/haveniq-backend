// ─── Safety triage endpoints (founder + moderators) ──────────────────────
//
// Power the /admin/safety screen. All routes gated behind isModeratorUser
// (founders are always moderators; extra moderators via MODERATOR_EMAILS) so a
// non-moderator hitting these gets a clean 403. Reduces the bus-factor of one:
// a trusted helper can work the report queue + bans without founder-only ops
// access.
//
// Endpoints:
//   GET    /admin/safety/reports             — open queue
//   GET    /admin/safety/reports?status=all  — full history
//   PATCH  /admin/safety/reports/:id         — update status / note
//   POST   /admin/safety/users/:id/ban       — ban a user (with reason)
//   POST   /admin/safety/users/:id/unban     — undo a ban
//   GET    /admin/safety/users/:id           — detail view: profile + their
//                                              reports filed + reports
//                                              against them + block count
//   GET    /admin/safety/most-blocked        — leaderboard of users with
//                                              the most blocks AGAINST
//                                              them in the last 30 days
//                                              (signal of bad behavior)

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { isModeratorUser } = require('../utils/founders');
const { audit } = require('../services/auditLog');
const analytics = require('../services/analytics');

// Trust-&-safety triage is open to founders AND designated moderators (see
// utils/founders.js — founders are always moderators). Ops/business endpoints
// elsewhere stay founder-only via the shared requireFounder middleware.
function requireModerator(req, res, next) {
  if (!isModeratorUser(req.user)) {
    return res.status(403).json({ error: 'Moderator access required.' });
  }
  next();
}

// ── GET /admin/safety/reports?status=open ────────────────────────────────
router.get('/reports', requireAuth, requireModerator, async (req, res) => {
  try {
    const status = String(req.query.status || 'open');
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const params = [];
    let where = '';
    if (status !== 'all') {
      params.push(status);
      where = `WHERE r.status = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT
         r.id, r.category, r.severity, r.reason, r.details, r.status,
         r.created_at, r.resolved_at, r.resolved_note,
         r.reporter_id, r.reported_id,
         reporter.first_name AS reporter_first_name,
         reporter.last_name  AS reporter_last_name,
         reporter.email      AS reporter_email,
         reported.first_name AS reported_first_name,
         reported.last_name  AS reported_last_name,
         reported.email      AS reported_email,
         reported.is_banned  AS reported_is_banned
       FROM user_reports r
       LEFT JOIN users reporter ON reporter.id = r.reporter_id
       LEFT JOIN users reported ON reported.id = r.reported_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ reports: rows });
  } catch (err) {
    console.error('[admin/safety/reports] failed:', err.message);
    res.status(500).json({ error: 'Could not load reports.' });
  }
});

// ── GET /admin/safety/message-flags?action=block|flag ────────────────────
// Auto-moderation audit: messages the content filter blocked (refused) or
// flagged (delivered but suspicious). Lets the founder spot repeat offenders
// and scam patterns. Tolerates the table not existing yet (returns []).
router.get('/message-flags', requireAuth, requireModerator, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
    const params = [];
    let where = '';
    if (req.query.action === 'block' || req.query.action === 'flag') {
      params.push(req.query.action);
      where = `WHERE f.action = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT
         f.id, f.action, f.category, f.excerpt, f.message_id,
         f.conversation_id, f.created_at, f.reviewed,
         f.sender_id, f.recipient_id,
         s.first_name AS sender_first_name, s.last_name AS sender_last_name,
         s.email AS sender_email, s.is_banned AS sender_is_banned,
         r.first_name AS recipient_first_name, r.last_name AS recipient_last_name
       FROM message_flags f
       LEFT JOIN users s ON s.id = f.sender_id
       LEFT JOIN users r ON r.id = f.recipient_id
       ${where}
       ORDER BY f.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ flags: rows });
  } catch (err) {
    // 42P01 = undefined_table — no flags recorded yet. Return empty, not 500.
    if (err.code === '42P01') return res.json({ flags: [] });
    console.error('[admin/safety/message-flags] failed:', err.message);
    res.status(500).json({ error: 'Could not load message flags.' });
  }
});

// ── PATCH /admin/safety/reports/:id ──────────────────────────────────────
// Body: { status?: 'reviewed' | 'actioned' | 'dismissed', note?: string }
router.patch('/reports/:id', requireAuth, requireModerator, async (req, res) => {
  try {
    const { status, note } = req.body || {};
    const allowed = ['open', 'reviewed', 'actioned', 'dismissed'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    const updates = [];
    const params  = [];
    let idx = 1;
    if (status) {
      updates.push(`status = $${idx++}`);
      params.push(status);
      if (status !== 'open') {
        updates.push(`resolved_at = NOW()`);
        updates.push(`resolved_by = $${idx++}`);
        params.push(req.user.id);
      }
    }
    if (typeof note === 'string') {
      updates.push(`resolved_note = $${idx++}`);
      params.push(note.slice(0, 2000));
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE user_reports SET ${updates.join(', ')}
        WHERE id = $${idx}
        RETURNING id, status, resolved_at, resolved_note`,
      params,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Report not found' });
    audit(req, 'admin.report.update', { reportId: req.params.id, status, note: !!note }).catch(() => {});
    res.json({ report: rows[0] });
  } catch (err) {
    console.error('[admin/safety/reports PATCH] failed:', err.message);
    res.status(500).json({ error: 'Could not update report.' });
  }
});

// ── POST /admin/safety/users/:id/ban ─────────────────────────────────────
// Body: { reason: string }
router.post('/users/:id/ban', requireAuth, requireModerator, async (req, res) => {
  try {
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "Can't ban yourself." });
    }
    const { rows } = await pool.query(
      `UPDATE users
          SET is_banned = TRUE, banned_at = NOW(), ban_reason = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, email, is_banned, banned_at, ban_reason`,
      [req.params.id, reason],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    audit(req, 'admin.user.ban', { userId: req.params.id, reason }).catch(() => {});
    analytics.track(analytics.EVENTS.user_banned, req.user.id, {
      target_user_id: req.params.id,
      reason,
    });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[admin/safety/ban] failed:', err.message);
    res.status(500).json({ error: 'Could not ban user.' });
  }
});

// ── POST /admin/safety/users/:id/unban ───────────────────────────────────
router.post('/users/:id/unban', requireAuth, requireModerator, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users
          SET is_banned = FALSE, banned_at = NULL, ban_reason = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING id, email, is_banned`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    audit(req, 'admin.user.unban', { userId: req.params.id }).catch(() => {});
    analytics.track(analytics.EVENTS.user_unbanned, req.user.id, {
      target_user_id: req.params.id,
    });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[admin/safety/unban] failed:', err.message);
    res.status(500).json({ error: 'Could not unban user.' });
  }
});

// ── GET /admin/safety/users/:id ──────────────────────────────────────────
// Detail view for a single user — profile + their report history (both
// directions) + block count against them.
router.get('/users/:id', requireAuth, requireModerator, async (req, res) => {
  try {
    const userId = req.params.id;
    const [profile, reportsAgainst, reportsFiled, blockCount] = await Promise.all([
      pool.query(
        `SELECT id, email, first_name, last_name, school, photo_url,
                is_banned, ban_reason, banned_at, is_paused,
                trust_score, quiz_completed, created_at
           FROM users WHERE id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT id, category, severity, reason, details, status, created_at,
                reporter_id
           FROM user_reports
          WHERE reported_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [userId],
      ),
      pool.query(
        `SELECT id, category, severity, reason, status, created_at, reported_id
           FROM user_reports
          WHERE reporter_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM user_blocks WHERE blocked_id = $1`,
        [userId],
      ),
    ]);
    if (profile.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({
      profile:        profile.rows[0],
      reportsAgainst: reportsAgainst.rows,
      reportsFiled:   reportsFiled.rows,
      blockCount:     blockCount.rows[0].n,
    });
  } catch (err) {
    console.error('[admin/safety/users :id] failed:', err.message);
    res.status(500).json({ error: 'Could not load user.' });
  }
});

// ── GET /admin/safety/most-blocked ───────────────────────────────────────
// Users with the most blocks against them in the last 30 days. Signal of
// real-world bad behavior — these are the next candidates for triage.
router.get('/most-blocked', requireAuth, requireModerator, async (req, res) => {
  try {
    const days  = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.school,
              u.is_banned,
              COUNT(b.id)::int AS block_count,
              COUNT(r.id)::int AS report_count
         FROM user_blocks b
         JOIN users u ON u.id = b.blocked_id
         LEFT JOIN user_reports r
                ON r.reported_id = u.id
               AND r.created_at > NOW() - ($1::int || ' days')::interval
        WHERE b.created_at > NOW() - ($1::int || ' days')::interval
        GROUP BY u.id
        HAVING COUNT(b.id) >= 2
        ORDER BY COUNT(b.id) DESC, COUNT(r.id) DESC
        LIMIT $2`,
      [days, limit],
    );
    res.json({ users: rows, windowDays: days });
  } catch (err) {
    console.error('[admin/safety/most-blocked] failed:', err.message);
    res.status(500).json({ error: 'Could not load leaderboard.' });
  }
});

module.exports = router;
