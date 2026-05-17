const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// Helper: confirm the caller is one of the two users on an accepted
// connect_request. All checklist operations gate on this — no one outside
// the matched pair should read or mutate their shared state.
async function loadMatchOrForbid(req, res) {
  const { rows } = await pool.query(
    `SELECT id, from_user, to_user, status FROM connect_requests
     WHERE id = $1 AND (from_user = $2 OR to_user = $2) AND status = 'accepted'`,
    [req.params.requestId, req.user.id],
  );
  if (!rows[0]) {
    res.status(403).json({ error: 'Not your match (or match not accepted)' });
    return null;
  }
  return rows[0];
}

// ── GET /checklists/:requestId ────────────────────────────────────────────
// Returns the shared checklist state for an accepted match. If no row
// exists yet, returns an empty `items` object — the client merges it with
// the default checklist on its side.
router.get('/:requestId', requireAuth, async (req, res) => {
  try {
    const match = await loadMatchOrForbid(req, res);
    if (!match) return;

    const { rows } = await pool.query(
      'SELECT items, updated_at FROM match_checklists WHERE request_id = $1',
      [req.params.requestId],
    );

    res.json({
      items:     rows[0]?.items ?? {},
      updatedAt: rows[0]?.updated_at ?? null,
    });
  } catch (err) {
    console.error('checklist load failed:', err);
    res.status(500).json({ error: 'Failed to load checklist' });
  }
});

// ── PATCH /checklists/:requestId ──────────────────────────────────────────
// Body: { items: { [itemId]: boolean, ... } }
// Merges the provided items into the existing row (or creates a new one).
// JSONB concatenation `||` means partial updates work — the client can
// send just the items that changed instead of the entire checklist.
router.patch('/:requestId', requireAuth, async (req, res) => {
  try {
    const match = await loadMatchOrForbid(req, res);
    if (!match) return;

    const { items } = req.body;
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      return res.status(400).json({ error: 'items object required' });
    }

    await pool.query(
      `INSERT INTO match_checklists (request_id, items, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (request_id) DO UPDATE SET
         items      = match_checklists.items || EXCLUDED.items,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by`,
      [req.params.requestId, JSON.stringify(items), req.user.id],
    );

    const { rows } = await pool.query(
      'SELECT items, updated_at FROM match_checklists WHERE request_id = $1',
      [req.params.requestId],
    );

    res.json({ items: rows[0].items, updatedAt: rows[0].updated_at });
  } catch (err) {
    console.error('checklist patch failed:', err);
    res.status(500).json({ error: 'Failed to update checklist' });
  }
});

module.exports = router;
