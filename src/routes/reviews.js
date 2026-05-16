const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// ── POST /reviews ─────────────────────────────────────────────────────────
// Submit (or update) a roommate review for another user. The UNIQUE
// constraint on (reviewer_id, reviewee_id) means each user can post one
// review per other user — re-submitting overwrites the prior one via
// ON CONFLICT.
//
// Body: {
//   revieweeId:    string (uuid),
//   overallRating: 1-5,
//   cleanliness:   1-5,
//   communication: 1-5,
//   respect:       1-5,
//   noiseLevel:    1-5,
//   body:          string (>=20 chars)
// }
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      revieweeId, overallRating, cleanliness,
      communication, respect, noiseLevel, body,
    } = req.body;

    if (!revieweeId) {
      return res.status(400).json({ error: 'revieweeId required' });
    }
    if (revieweeId === req.user.id) {
      return res.status(400).json({ error: 'Cannot review yourself' });
    }
    const scores = { overallRating, cleanliness, communication, respect, noiseLevel };
    for (const [k, v] of Object.entries(scores)) {
      if (!Number.isInteger(v) || v < 1 || v > 5) {
        return res.status(400).json({ error: `${k} must be an integer 1-5` });
      }
    }
    if (typeof body !== 'string' || body.trim().length < 20) {
      return res.status(400).json({ error: 'body must be at least 20 characters' });
    }

    const { rows } = await pool.query(
      `INSERT INTO roommate_reviews
         (reviewer_id, reviewee_id, overall_rating, cleanliness,
          communication, respect, noise_level, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (reviewer_id, reviewee_id) DO UPDATE SET
         overall_rating = EXCLUDED.overall_rating,
         cleanliness    = EXCLUDED.cleanliness,
         communication  = EXCLUDED.communication,
         respect        = EXCLUDED.respect,
         noise_level    = EXCLUDED.noise_level,
         body           = EXCLUDED.body,
         created_at     = NOW()
       RETURNING id, created_at`,
      [
        req.user.id, revieweeId, overallRating, cleanliness,
        communication, respect, noiseLevel, body.trim(),
      ],
    );

    res.json({ id: rows[0].id, createdAt: rows[0].created_at });
  } catch (err) {
    console.error('review submit failed:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// ── GET /reviews/user/:id ─────────────────────────────────────────────────
// Public reviews for a given user. Reviewer identity is intentionally
// omitted — reviews are surfaced as anonymous to encourage honesty.
router.get('/user/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, overall_rating, cleanliness, communication, respect,
              noise_level, body, helpful_count, created_at
       FROM roommate_reviews
       WHERE reviewee_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    console.error('review list failed:', err);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

module.exports = router;
