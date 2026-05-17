const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// ── GET /pulses/pending ──────────────────────────────────────────────────
// Returns up to one outcome-pulse prompt the user currently owes. We pick
// the OLDEST overdue day-marker that hasn't been answered yet, so users
// get one card at a time instead of a queue. Eligibility windows:
//   30-day marker: 30+ days after accept
//   60-day marker: 60+ days after accept
//   90-day marker: 90+ days after accept
//
// Returned shape (or null):
//   { requestId, dayMarker, matchUser: { firstName, lastInitial, photoUrl } }
router.get('/pending', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      WITH accepted AS (
        SELECT cr.id AS request_id,
               cr.updated_at AS accepted_at,
               CASE WHEN cr.from_user = $1 THEN cr.to_user ELSE cr.from_user END AS other_user_id
        FROM connect_requests cr
        WHERE cr.status = 'accepted'
          AND (cr.from_user = $1 OR cr.to_user = $1)
      ),
      windows AS (
        SELECT request_id, accepted_at, other_user_id, day_marker
        FROM accepted
        CROSS JOIN (VALUES (30), (60), (90)) AS m(day_marker)
        WHERE accepted_at + (day_marker || ' days')::interval <= NOW()
      ),
      pending AS (
        SELECT w.request_id, w.day_marker, w.other_user_id, w.accepted_at
        FROM windows w
        LEFT JOIN match_pulses mp
               ON mp.request_id = w.request_id
              AND mp.responder_id = $1
              AND mp.day_marker = w.day_marker
        WHERE mp.id IS NULL
        ORDER BY w.accepted_at ASC, w.day_marker ASC
        LIMIT 1
      )
      SELECT p.request_id, p.day_marker,
             u.first_name, u.last_name, u.photo_url
      FROM pending p
      JOIN users u ON u.id = p.other_user_id
      `,
      [req.user.id],
    );

    if (!rows[0]) return res.json(null);

    res.json({
      requestId: rows[0].request_id,
      dayMarker: rows[0].day_marker,
      matchUser: {
        firstName:   rows[0].first_name,
        lastInitial: (rows[0].last_name || '').charAt(0),
        photoUrl:    rows[0].photo_url,
      },
    });
  } catch (err) {
    console.error('pulse pending lookup failed:', err);
    res.status(500).json({ error: 'Failed to load pending pulse' });
  }
});

// ── POST /pulses ──────────────────────────────────────────────────────────
// Submit a pulse response. UNIQUE constraint on (request_id, responder_id,
// day_marker) means re-submitting the same pulse is rejected at the DB
// level — keeps the outcome dataset clean for fundraising decks.
//
// Body: { requestId, dayMarker (30|60|90), status, note? }
router.post('/', requireAuth, async (req, res) => {
  try {
    const { requestId, dayMarker, status, note } = req.body;

    if (!requestId) return res.status(400).json({ error: 'requestId required' });
    if (![30, 60, 90].includes(dayMarker)) {
      return res.status(400).json({ error: 'dayMarker must be 30, 60, or 90' });
    }
    if (!['going_well', 'having_issues', 'not_connected', 'moved_out'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }

    // Confirm the user is one of the two parties on this request.
    const { rows: own } = await pool.query(
      `SELECT id FROM connect_requests
       WHERE id = $1 AND status = 'accepted' AND (from_user = $2 OR to_user = $2)`,
      [requestId, req.user.id],
    );
    if (!own[0]) return res.status(403).json({ error: 'Not your match' });

    await pool.query(
      `INSERT INTO match_pulses (request_id, responder_id, day_marker, status, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id, responder_id, day_marker) DO NOTHING`,
      [requestId, req.user.id, dayMarker, status, note ?? null],
    );

    res.json({ recorded: true });
  } catch (err) {
    console.error('pulse submit failed:', err);
    res.status(500).json({ error: 'Failed to record pulse' });
  }
});

module.exports = router;
