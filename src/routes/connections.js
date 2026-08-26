/**
 * Social connections — the backend half of stores/socialGraphStore.ts
 * (haveniq-app). Was local-only on one device: sendConnectionRequest() wrote
 * to SecureStore and fired a one-way analytics event, so the "other user"
 * never learned the request existed. This is the real, two-sided version.
 *
 * v1 scope, cut down from the original sketch on purpose:
 *   - No ConnectionType taxonomy (friend/classmate/past_roommate/...) — just
 *     a binary confirmed relationship. Re-add typing later only if there's
 *     real demand for it.
 *   - One row per pair, EVER (idx_connections_pair, a unique index on the
 *     canonically-ordered pair) — requesting again after an existing row
 *     just returns its current state idempotently, never a duplicate. To
 *     try again after a decline, remove the connection first (DELETE), then
 *     request again — no separate "un-decline" behavior.
 *   - Entry point is the existing match/thread screen in the app, not a new
 *     discovery/search surface — avoids the empty-results cold-start problem
 *     a "find classmates" feature would have at a brand-new campus.
 *
 * One row visible to BOTH sides, labeled from the caller's own perspective
 * (pending_outbound / pending_inbound / confirmed / declined) — same
 * "one row, two views" principle as circle.js's mutual-direction fix.
 */
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');

// Overall % → tier. MUST match the frontend (haveniq-app utils/fitTier.ts: 90/80/70/60).
function tierFor(pct) {
  if (pct >= 90) return 'exceptional';
  if (pct >= 80) return 'strong';
  if (pct >= 70) return 'good';
  if (pct >= 60) return 'moderate';
  return 'low';
}

// Self-healing table create, cached per process — same shape as
// services/conflictPulses.js. A fresh DB or skipped migration loses nothing.
let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connections (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    )`);
  // One row per pair, ever, regardless of who requested — an expression
  // index on the canonically-ordered pair, not a plain column UNIQUE, since
  // (A,B) and (B,A) must collide.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_pair
      ON connections (LEAST(requester_id, target_id), GREATEST(requester_id, target_id))`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_connections_target ON connections(target_id, status)`);
  tableReady = true;
}

// GET /connections — every connection touching me, in either direction,
// labeled from MY perspective, with my compatibility to each (same honest
// score/tier rules as circle.js: null until both finished the quiz).
router.get('/', requireAuth, async (req, res) => {
  await ensureTable();
  try {
    const uid = req.user.id;
    const { rows } = await pool.query(
      `SELECT c.id, c.status, c.requester_id, c.target_id, c.created_at, c.confirmed_at,
              u.id AS other_id, u.first_name, u.last_name, u.photo_url,
              u.school_year, u.quiz_completed, cs.score
         FROM connections c
         JOIN users u
           ON u.id = CASE WHEN c.requester_id = $1::uuid THEN c.target_id ELSE c.requester_id END
         LEFT JOIN compatibility_scores cs
           ON cs.user_a = LEAST(u.id, $1::uuid) AND cs.user_b = GREATEST(u.id, $1::uuid)
        WHERE c.requester_id = $1::uuid OR c.target_id = $1::uuid
        ORDER BY c.created_at DESC`,
      [uid],
    );
    const connections = rows.map((r) => {
      const status = r.status === 'pending'
        ? (r.requester_id === uid ? 'pending_outbound' : 'pending_inbound')
        : r.status; // 'confirmed' | 'declined'
      let score = null;
      if (r.quiz_completed === true && r.score != null) {
        const finalPct = Math.round(parseFloat(r.score));
        score = { finalPct, tier: tierFor(finalPct) };
      }
      return {
        id:           r.id,
        userId:       r.other_id,
        firstName:    r.first_name || '',
        lastInitial:  (r.last_name || '').trim().charAt(0).toUpperCase() || '',
        photoUrl:     r.photo_url || null,
        schoolYear:   r.school_year || undefined,
        quizComplete: r.quiz_completed === true,
        score,
        status,
        createdAt:    r.created_at,
        confirmedAt:  r.confirmed_at,
      };
    });
    res.json({ ok: true, connections });
  } catch (e) {
    console.error('[connections] list failed:', e.message);
    res.status(500).json({ ok: false, connections: [] });
  }
});

// POST /connections/request { targetUserId }
router.post('/request', requireAuth, refuseBanned, async (req, res) => {
  await ensureTable();
  try {
    const targetUserId = req.body?.targetUserId;
    if (typeof targetUserId !== 'string' || !targetUserId) {
      return res.status(400).json({ ok: false, error: 'targetUserId required' });
    }
    if (targetUserId === req.user.id) {
      return res.status(400).json({ ok: false, error: "You can't connect with yourself" });
    }

    // Idempotent: a pair can only ever have one row (idx_connections_pair).
    // If one already exists, return its current state honestly rather than
    // erroring or attempting a duplicate insert that would just violate the
    // unique index anyway.
    const { rows: existing } = await pool.query(
      `SELECT id, status, requester_id FROM connections
        WHERE LEAST(requester_id, target_id) = LEAST($1::uuid, $2::uuid)
          AND GREATEST(requester_id, target_id) = GREATEST($1::uuid, $2::uuid)`,
      [req.user.id, targetUserId],
    );
    if (existing[0]) {
      const status = existing[0].status === 'pending'
        ? (existing[0].requester_id === req.user.id ? 'pending_outbound' : 'pending_inbound')
        : existing[0].status;
      return res.json({ ok: true, id: existing[0].id, status });
    }

    const { rows } = await pool.query(
      `INSERT INTO connections (requester_id, target_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [req.user.id, targetUserId],
    );

    const sendPushToUser = req.app.get('sendPushToUser');
    if (sendPushToUser) {
      const requesterName = req.user.first_name || 'Someone';
      sendPushToUser(targetUserId, {
        title: 'New connection request',
        body: `${requesterName} wants to connect with you on HavenIQ`,
        data: { screen: 'circle' },
      }).catch(err => console.error('[push] connection request send failed:', err));
    }

    res.json({ ok: true, id: rows[0].id, status: 'pending_outbound' });
  } catch (e) {
    console.error('[connections] request failed:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to send request' });
  }
});

// POST /connections/:id/accept — only the RECIPIENT (target_id) may accept.
router.post('/:id/accept', requireAuth, refuseBanned, async (req, res) => {
  await ensureTable();
  try {
    const { rows } = await pool.query(
      `UPDATE connections
          SET status = 'confirmed', confirmed_at = NOW()
        WHERE id = $1 AND target_id = $2 AND status = 'pending'
        RETURNING id, requester_id`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) {
      return res.status(404).json({ ok: false, error: 'Pending request not found' });
    }

    const sendPushToUser = req.app.get('sendPushToUser');
    if (sendPushToUser) {
      const accepterName = req.user.first_name || 'Someone';
      sendPushToUser(rows[0].requester_id, {
        title: 'Connection accepted ✦',
        body: `${accepterName} accepted your connection request`,
        data: { screen: 'circle' },
      }).catch(err => console.error('[push] connection accept send failed:', err));
    }

    res.json({ ok: true, status: 'confirmed' });
  } catch (e) {
    console.error('[connections] accept failed:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to accept' });
  }
});

// POST /connections/:id/decline — only the RECIPIENT (target_id) may decline.
// No push on decline (same convention as matches.js's /respond) — a decline
// notification is a bad-feeling push nobody asked for.
router.post('/:id/decline', requireAuth, refuseBanned, async (req, res) => {
  await ensureTable();
  try {
    const { rows } = await pool.query(
      `UPDATE connections
          SET status = 'declined'
        WHERE id = $1 AND target_id = $2 AND status = 'pending'
        RETURNING id`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) {
      return res.status(404).json({ ok: false, error: 'Pending request not found' });
    }
    res.json({ ok: true, status: 'declined' });
  } catch (e) {
    console.error('[connections] decline failed:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to decline' });
  }
});

// DELETE /connections/:id — either side may remove a connection in any state.
router.delete('/:id', requireAuth, async (req, res) => {
  await ensureTable();
  try {
    const { rows } = await pool.query(
      `DELETE FROM connections
        WHERE id = $1 AND (requester_id = $2 OR target_id = $2)
        RETURNING id`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) {
      return res.status(404).json({ ok: false, error: 'Connection not found' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[connections] remove failed:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to remove' });
  }
});

module.exports = router;
