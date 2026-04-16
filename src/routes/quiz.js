const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { calculateCompatibility, generateWhyMatched } = require('../services/scoring');

// ── POST /quiz/save ───────────────────────────────────────────────────────
// Save quiz progress (called after every answer for save & resume)
router.post('/save', requireAuth, async (req, res) => {
  try {
    const { answers } = req.body;
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'answers object required' });
    }

    await pool.query(
      `INSERT INTO quiz_answers (user_id, answers, completed)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (user_id) DO UPDATE
       SET answers = $2, updated_at = NOW()`,
      [req.user.id, JSON.stringify(answers)]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

// ── GET /quiz/progress ────────────────────────────────────────────────────
// Resume: return saved answers
router.get('/progress', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT answers, completed FROM quiz_answers WHERE user_id = $1',
      [req.user.id]
    );

    if (!rows[0]) return res.json({ answers: null, completed: false });
    res.json({ answers: rows[0].answers, completed: rows[0].completed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// ── POST /quiz/submit ─────────────────────────────────────────────────────
// Final submission — marks complete, triggers async match scoring
router.post('/submit', requireAuth, async (req, res) => {
  try {
    const { answers } = req.body;
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'answers object required' });
    }

    // Save final answers and mark completed
    await pool.query(
      `INSERT INTO quiz_answers (user_id, answers, completed)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id) DO UPDATE
       SET answers = $2, completed = TRUE, updated_at = NOW()`,
      [req.user.id, JSON.stringify(answers)]
    );

    // Mark user as quiz_completed
    await pool.query(
      'UPDATE users SET quiz_completed = TRUE WHERE id = $1',
      [req.user.id]
    );

    // Trigger async match scoring (non-blocking)
    scoreNewMatches(req.user.id, answers).catch(err =>
      console.error('Async scoring error:', err)
    );

    res.json({ success: true, message: 'Quiz submitted. Calculating your matches...' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

// ── Async: score against all other completed users ────────────────────────
async function scoreNewMatches(userId, newAnswers) {
  // Get all other users who completed the quiz, same school
  const { rows: userRow } = await pool.query(
    'SELECT school FROM users WHERE id = $1',
    [userId]
  );
  if (!userRow[0]) return;

  const { rows: otherUsers } = await pool.query(
    `SELECT qa.user_id, qa.answers
     FROM quiz_answers qa
     JOIN users u ON u.id = qa.user_id
     WHERE qa.completed = TRUE
       AND qa.user_id != $1
       AND u.is_paused = FALSE`,
    [userId]
  );

  for (const other of otherUsers) {
    const result = calculateCompatibility(newAnswers, other.answers);

    // Skip if hard blocked
    if (result.isHardBlocked) continue;

    // Canonical pair ordering (smaller UUID first)
    const [userA, userB] = userId < other.user_id
      ? [userId, other.user_id]
      : [other.user_id, userId];

    const whyMatched = generateWhyMatched(result.breakdown, result.finalPct);

    await pool.query(
      `INSERT INTO compatibility_scores
         (user_a, user_b, score, is_hard_blocked, is_soft_blocked, shadow_penalty, breakdown, why_matched)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_a, user_b) DO UPDATE
       SET score=$3, is_hard_blocked=$4, is_soft_blocked=$5,
           shadow_penalty=$6, breakdown=$7, why_matched=$8, calculated_at=NOW()`,
      [
        userA, userB,
        result.finalPct,
        result.isHardBlocked,
        result.isSoftBlocked,
        result.shadowPenalty,
        JSON.stringify(result.breakdown),
        whyMatched,
      ]
    );
  }
}

module.exports = router;
