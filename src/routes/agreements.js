// ─── Shared roommate agreement ──────────────────────────────────────────────
//
// The "joint act of agreeing" CSUF housing told us matters more than the match
// itself. Unlike the personal planning checklist (kept client-side in the app's
// homeStore), THIS is one shared document per conversation that BOTH roommates
// see and edit — keyed to the conversation so it only exists once two people
// have actually connected. Each rule records who set it, so it reads as a thing
// they built together, and the retention check-ins revisit it through the year.

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const { screenMessage } = require('../lib/contentFilter');

// Self-migrating: one row per conversation, items as JSONB
// [{ topic, value, setBy, setByName, updatedAt }].
let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_agreements (
      conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      items           JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  ensured = true;
}

// Only the two people in the conversation may read or edit its agreement.
async function isMember(conversationId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)',
    [conversationId, userId],
  );
  return rows.length > 0;
}

// GET /agreements/:conversationId — the shared doc (both roommates see the same).
router.get('/:conversationId', requireAuth, async (req, res) => {
  try {
    await ensureTable();
    if (!(await isMember(req.params.conversationId, req.user.id))) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const { rows } = await pool.query(
      'SELECT items FROM shared_agreements WHERE conversation_id = $1',
      [req.params.conversationId],
    );
    res.json({ items: Array.isArray(rows[0]?.items) ? rows[0].items : [] });
  } catch (err) {
    console.error('[agreements] get failed:', err.message);
    res.status(500).json({ error: 'Could not load the agreement' });
  }
});

// PUT /agreements/:conversationId — upsert one rule. Either roommate can set or
// update any topic; we stamp who did it. Body: { topic, value }.
router.put('/:conversationId', requireAuth, refuseBanned, async (req, res) => {
  try {
    await ensureTable();
    const { topic, value } = req.body || {};
    if (typeof topic !== 'string' || !topic.trim()) {
      return res.status(400).json({ error: 'topic required' });
    }
    if (typeof value !== 'string' || value.length > 280) {
      return res.status(400).json({ error: 'value must be a string under 280 chars' });
    }
    if (!(await isMember(req.params.conversationId, req.user.id))) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    // The value is shown to the other roommate — screen it like any UGC.
    if (value.trim() && screenMessage(value).action === 'block') {
      return res.status(422).json({ code: 'content_blocked', error: 'That can\'t be saved. Keep the agreement respectful.' });
    }

    const { rows } = await pool.query(
      'SELECT items FROM shared_agreements WHERE conversation_id = $1',
      [req.params.conversationId],
    );
    const items = Array.isArray(rows[0]?.items) ? rows[0].items : [];
    const entry = {
      topic:     topic.trim(),
      value:     value.trim(),
      setBy:     req.user.id,
      setByName: req.user.first_name || 'Roommate',
      updatedAt: new Date().toISOString(),
    };
    const idx = items.findIndex(i => i && i.topic === entry.topic);
    if (idx >= 0) items[idx] = entry; else items.push(entry);

    await pool.query(
      `INSERT INTO shared_agreements (conversation_id, items, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (conversation_id) DO UPDATE SET items = $2, updated_at = NOW()`,
      [req.params.conversationId, JSON.stringify(items)],
    );
    res.json({ items });
  } catch (err) {
    console.error('[agreements] put failed:', err.message);
    res.status(500).json({ error: 'Could not save the agreement' });
  }
});

module.exports = router;
