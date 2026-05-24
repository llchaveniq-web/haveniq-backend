// ─── House Rules — per-user rule drafts ──────────────────────────────────
//
// User-scoped: rules belong to the proposing user and are visible only to
// them. Multi-roommate voting / household sharing is a future expansion;
// keeping the scope simple here means we don't ship a half-implemented
// "your rule has been sent to all roommates" lie.

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { submitRule, quickAction } = require('../middleware/rateLimits');

const VALID_CATEGORIES = new Set([
  'Temperature', 'Quiet Hours', 'Guests', 'Cleanliness', 'Pets',
]);

// GET /house-rules — list this user's rules, newest first.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, category, text, why, vote_required, thumbs_up, created_at
         FROM house_rules
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id],
    );
    res.json({ rules: rows });
  } catch (err) {
    console.error('[house-rules GET] failed:', err.message);
    res.status(500).json({ error: 'Could not load your house rules.' });
  }
});

// POST /house-rules — create a new rule.
// Body: { category, text, why?, voteRequired? }
router.post('/', requireAuth, submitRule, async (req, res) => {
  try {
    const { category, text, why, voteRequired = true } = req.body || {};
    if (!category || !VALID_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `category must be one of ${[...VALID_CATEGORIES].join(', ')}` });
    }
    if (typeof text !== 'string' || text.trim().length < 3) {
      return res.status(400).json({ error: 'text must be at least 3 characters' });
    }
    const { rows } = await pool.query(
      `INSERT INTO house_rules (user_id, category, text, why, vote_required)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, category, text, why, vote_required, thumbs_up, created_at`,
      [req.user.id, category, text.trim(), why?.trim() || null, !!voteRequired],
    );
    res.status(201).json({ rule: rows[0] });
  } catch (err) {
    console.error('[house-rules POST] failed:', err.message);
    res.status(500).json({ error: 'Could not save the rule.' });
  }
});

// POST /house-rules/:id/thumb — increment thumbs_up on a rule the user owns.
// Idempotent in the sense that calling it twice does NOT double-count —
// frontend tracks the local "thumbed" set per session, this just records
// the +1 if it's a fresh thumb.
router.post('/:id/thumb', requireAuth, quickAction, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE house_rules
         SET thumbs_up = thumbs_up + 1
       WHERE id = $1 AND user_id = $2
       RETURNING id, thumbs_up`,
      [req.params.id, req.user.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ rule: rows[0] });
  } catch (err) {
    console.error('[house-rules thumb] failed:', err.message);
    res.status(500).json({ error: 'Could not record the thumbs up.' });
  }
});

// DELETE /house-rules/:id — delete a rule the user owns.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM house_rules WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[house-rules DELETE] failed:', err.message);
    res.status(500).json({ error: 'Could not delete the rule.' });
  }
});

module.exports = router;
