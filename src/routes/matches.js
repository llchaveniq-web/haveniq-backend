const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// ── GET /matches/feed ─────────────────────────────────────────────────────
// Returns scored, filtered matches for the current user
router.get('/feed', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { school } = req.query;  // optional school filter

    const { rows } = await pool.query(
      `SELECT
         cs.score,
         cs.is_soft_blocked,
         cs.shadow_penalty,
         cs.breakdown,
         cs.why_matched,
         u.id,
         u.first_name,
         u.last_name,
         u.school,
         u.school_year,
         u.major,
         u.bio,
         u.gender,
         u.looking_for,
         u.photo_url,
         u.budget_min,
         u.budget_max,
         u.move_in_timeline,
         u.is_verified,
         u.trust_score,
         cr.status AS connect_status
       FROM compatibility_scores cs
       JOIN users u ON (
         CASE WHEN cs.user_a = $1 THEN cs.user_b ELSE cs.user_a END = u.id
       )
       LEFT JOIN connect_requests cr ON (
         (cr.from_user = $1 AND cr.to_user = u.id) OR
         (cr.to_user = $1   AND cr.from_user = u.id)
       )
       WHERE (cs.user_a = $1 OR cs.user_b = $1)
         AND cs.is_hard_blocked = FALSE
         AND cs.score >= 65
         AND u.is_paused = FALSE
         AND u.quiz_completed = TRUE
         ${school ? 'AND u.school = $2' : ''}
       ORDER BY cs.score DESC
       LIMIT 50`,
      school ? [userId, school] : [userId]
    );

    const matches = rows.map(r => ({
      userId:        r.id,
      firstName:     r.first_name,
      lastName:      r.last_name,
      school:        r.school,
      schoolYear:    r.school_year,
      major:         r.major,
      bio:           r.bio,
      gender:        r.gender,
      lookingFor:    r.looking_for || [],
      photoUrl:      r.photo_url,
      budgetMin:     r.budget_min,
      budgetMax:     r.budget_max,
      moveInTimeline:r.move_in_timeline,
      isVerified:    r.is_verified,
      trustScore:    r.trust_score,
      compatScore:   parseFloat(r.score),
      isSoftBlocked: r.is_soft_blocked,
      shadowPenalty: parseFloat(r.shadow_penalty),
      breakdown:     r.breakdown || {},
      whyMatched:    r.why_matched,
      connectStatus: r.connect_status || null,
    }));

    res.json(matches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// ── POST /matches/connect ─────────────────────────────────────────────────
// Send a connect request
router.post('/connect', requireAuth, async (req, res) => {
  try {
    const { toUserId } = req.body;
    if (!toUserId) return res.status(400).json({ error: 'toUserId required' });

    // Check if already connected or pending
    const { rows: existing } = await pool.query(
      `SELECT status FROM connect_requests
       WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`,
      [req.user.id, toUserId]
    );

    if (existing[0]) {
      return res.status(409).json({ error: 'Request already exists', status: existing[0].status });
    }

    await pool.query(
      'INSERT INTO connect_requests (from_user, to_user, status) VALUES ($1, $2, $3)',
      [req.user.id, toUserId, 'pending']
    );

    res.json({ success: true, status: 'pending' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send connect request' });
  }
});

// ── POST /matches/respond ─────────────────────────────────────────────────
// Accept or decline a connect request
router.post('/respond', requireAuth, async (req, res) => {
  try {
    const { fromUserId, action } = req.body; // action: 'accept' | 'decline'
    if (!fromUserId || !['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'fromUserId and action (accept|decline) required' });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'declined';

    const { rows } = await pool.query(
      `UPDATE connect_requests SET status = $1, updated_at = NOW()
       WHERE from_user = $2 AND to_user = $3 AND status = 'pending'
       RETURNING *`,
      [newStatus, fromUserId, req.user.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Pending request not found' });
    }

    // If accepted, create a conversation
    if (action === 'accept') {
      const [userA, userB] = req.user.id < fromUserId
        ? [req.user.id, fromUserId]
        : [fromUserId, req.user.id];

      await pool.query(
        `INSERT INTO conversations (user_a, user_b)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userA, userB]
      );
    }

    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to respond to request' });
  }
});

// ── GET /matches/requests ─────────────────────────────────────────────────
// Incoming pending requests
router.get('/requests', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cr.id, cr.from_user, cr.created_at,
              u.first_name, u.last_name, u.school, u.photo_url,
              cs.score
       FROM connect_requests cr
       JOIN users u ON u.id = cr.from_user
       LEFT JOIN compatibility_scores cs ON (
         (cs.user_a = cr.from_user AND cs.user_b = $1) OR
         (cs.user_b = cr.from_user AND cs.user_a = $1)
       )
       WHERE cr.to_user = $1 AND cr.status = 'pending'
       ORDER BY cr.created_at DESC`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

module.exports = router;
