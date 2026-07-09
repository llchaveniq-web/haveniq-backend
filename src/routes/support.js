// ─── Support triage — the "Report a problem" queue (founder + moderators) ───
//
// Report-a-problem submissions land in user_problem_reports (see telemetry.js).
// This exposes the STAFF side so there's a real support loop instead of a raw
// inbox: list the queue, reply to the student by email, and close reports out.
// Gated on isModeratorUser (founder + designated moderators — see utils/founders).

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { isModeratorUser } = require('../utils/founders');
const { sendSupportReplyEmail } = require('../services/email');
const { audit } = require('../services/auditLog');

function requireModerator(req, res, next) {
  if (!isModeratorUser(req.user)) {
    return res.status(403).json({ error: 'Moderator access required.' });
  }
  next();
}

const STATUSES = ['open', 'answered', 'closed'];

// GET /admin/support?status=open — the queue (open first, then newest first).
router.get('/', requireAuth, requireModerator, async (req, res) => {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const { rows } = await pool.query(
      `SELECT r.id, r.message, r.screen, r.app_version, r.status, r.staff_reply,
              r.replied_at, r.created_at,
              u.id AS user_id, u.first_name, u.email, u.school
         FROM user_problem_reports r
         LEFT JOIN users u ON u.id = r.user_id
        ${status ? 'WHERE r.status = $1' : ''}
        ORDER BY (r.status = 'open') DESC, r.created_at DESC
        LIMIT 200`,
      status ? [status] : [],
    );
    res.json({ reports: rows });
  } catch (err) {
    console.error('[admin/support GET] failed:', err.message);
    res.status(500).json({ error: 'Could not load support reports.' });
  }
});

// POST /admin/support/:id/reply — reply to the student by email + mark answered.
router.post('/:id/reply', requireAuth, requireModerator, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (typeof message !== 'string' || message.trim().length < 2) {
      return res.status(400).json({ error: 'A reply message is required.' });
    }
    const { rows } = await pool.query(
      `SELECT r.id, r.message, r.user_id, u.email, u.first_name
         FROM user_problem_reports r
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.id = $1`,
      [req.params.id],
    );
    const report = rows[0];
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    if (!report.email) return res.status(409).json({ error: 'That user no longer has an email on file.' });

    // Send BEFORE marking answered — a mail failure must not hide an unhandled
    // report as done.
    await sendSupportReplyEmail({
      toEmail:         report.email,
      toName:          report.first_name,
      replyBody:       message.trim(),
      originalMessage: report.message,
    });

    await pool.query(
      `UPDATE user_problem_reports
          SET status = 'answered', staff_reply = $1, replied_at = NOW(), handled_by = $2
        WHERE id = $3`,
      [message.trim(), req.user.id, report.id],
    );
    audit(req, 'support.reply', { report: report.id, to: report.user_id }).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/support reply] failed:', err.message);
    res.status(502).json({ error: 'Could not send the reply. Try again in a moment.' });
  }
});

// PATCH /admin/support/:id — change status (e.g. close without replying, or reopen).
router.patch('/:id', requireAuth, requireModerator, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    }
    const { rows } = await pool.query(
      `UPDATE user_problem_reports SET status = $1, handled_by = $2 WHERE id = $3 RETURNING id, status`,
      [status, req.user.id, req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Report not found.' });
    audit(req, 'support.status', { report: req.params.id, status }).catch(() => {});
    res.json({ success: true, report: rows[0] });
  } catch (err) {
    console.error('[admin/support PATCH] failed:', err.message);
    res.status(500).json({ error: 'Could not update the report.' });
  }
});

module.exports = router;
