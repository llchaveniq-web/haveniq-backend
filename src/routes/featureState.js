/**
 * Generic per-feature state store.
 *
 * One table, two endpoints — powers persistence for ANY feature without a
 * bespoke table/route each. A feature picks a stable `key` (e.g.
 * "chore-wheel") and round-trips its whole UI state as a JSON blob:
 *
 *   GET  /feature-state/:key        → { state, updatedAt }
 *   PUT  /feature-state/:key { state } → upsert
 *
 * Scoped to the authenticated user. (Group-scoped variant — shared roommate
 * tools where every roommate sees the same data — can layer on later via a
 * `group_id` column; user scope is the right MVP.)
 */
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// Stable feature keys: lowercase-ish slug, dashes/underscores/slashes. Keeps
// junk out of the table and makes keys predictable.
const KEY_RE = /^[a-zA-Z0-9_\-\/]{1,80}$/;

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_state (
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      feature_key  TEXT NOT NULL,
      state        JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, feature_key)
    );
  `).catch((e) => console.error('[feature_state] ensure table:', e.message));
}

// GET /feature-state/:key — returns the saved state (or null if none yet).
router.get('/:key', requireAuth, async (req, res) => {
  try {
    const { key } = req.params;
    if (!KEY_RE.test(key)) return res.status(400).json({ error: 'invalid feature key' });
    await ensureTable();
    const { rows } = await pool.query(
      'SELECT state, updated_at FROM feature_state WHERE user_id = $1 AND feature_key = $2',
      [req.user.id, key],
    );
    res.json({ state: rows[0] ? rows[0].state : null, updatedAt: rows[0] ? rows[0].updated_at : null });
  } catch (e) {
    console.error('[feature_state] get:', e.message);
    res.status(500).json({ error: 'Failed to load saved state' });
  }
});

// PUT /feature-state/:key { state } — upsert the whole blob.
router.put('/:key', requireAuth, async (req, res) => {
  try {
    const { key } = req.params;
    if (!KEY_RE.test(key)) return res.status(400).json({ error: 'invalid feature key' });
    const state = req.body ? req.body.state : undefined;
    if (state === undefined) return res.status(400).json({ error: 'state is required' });
    // Size guard — a feature blob is small UI state, not a data dump.
    const json = JSON.stringify(state);
    if (json.length > 200_000) return res.status(413).json({ error: 'state too large' });
    await ensureTable();
    await pool.query(
      `INSERT INTO feature_state (user_id, feature_key, state, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (user_id, feature_key)
       DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [req.user.id, key, json],
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[feature_state] put:', e.message);
    res.status(500).json({ error: 'Failed to save' });
  }
});

module.exports = router;
