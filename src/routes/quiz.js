const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { calculateCompatibility, generateWhyMatched } = require('../services/scoring');

// Cap per free-text answer to keep one bad actor from stuffing 10MB
// of garbage into the quiz_answers JSONB column. 5000 chars is roughly
// 1000 words — far more than any legitimate clinical-quiz reflection.
const MAX_TEXT_ANSWER_CHARS = 5000;

function validateAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return 'answers object required';
  }
  for (const [k, v] of Object.entries(answers)) {
    // Answers come in two shapes: { type: 'choice', value: number } or
    // { type: 'text', text: string }. We only need to cap text shapes.
    if (v && typeof v === 'object' && v.type === 'text') {
      if (typeof v.text !== 'string') return `answer ${k}: text must be a string`;
      if (v.text.length > MAX_TEXT_ANSWER_CHARS) {
        return `answer ${k}: text exceeds ${MAX_TEXT_ANSWER_CHARS} char limit`;
      }
    }
  }
  return null;
}

// ── POST /quiz/save ───────────────────────────────────────────────────────
// Save quiz progress (called after every answer for save & resume)
router.post('/save', requireAuth, async (req, res) => {
  try {
    const { answers } = req.body || {};
    const err = validateAnswers(answers);
    if (err) return res.status(400).json({ error: err });

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
    const { answers } = req.body || {};
    const err = validateAnswers(answers);
    if (err) return res.status(400).json({ error: err });

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

    // Longitudinal snapshot — captures the user's profile + quiz state at
    // the moment of completion. Powers drift analysis when they re-take
    // the quiz months later. Best-effort: failures are logged, not fatal.
    pool.query(
      `INSERT INTO user_profile_snapshot (user_id, trigger, snapshot)
       SELECT $1, 'quiz_complete', jsonb_build_object(
         'profile', to_jsonb(u) - 'password_hash',
         'answers', $2::jsonb
       )
       FROM users u WHERE u.id = $1`,
      [req.user.id, JSON.stringify(answers)],
    ).catch(err => console.error('snapshot insert failed:', err));

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

  // Build all the score rows in one pass, then bulk-INSERT in a single
  // round-trip. Previously this fired one INSERT per other user — at 100
  // students the 100th signup serialized 99 round-trips through the
  // connection pool. Batching collapses that to a single statement.
  const rows = [];
  for (const other of otherUsers) {
    const result = calculateCompatibility(newAnswers, other.answers);
    if (result.isHardBlocked) continue;
    const [userA, userB] = userId < other.user_id
      ? [userId, other.user_id]
      : [other.user_id, userId];
    rows.push([
      userA, userB,
      result.finalPct,
      result.isHardBlocked,
      result.isSoftBlocked,
      result.shadowPenalty,
      JSON.stringify(result.breakdown),
      generateWhyMatched(result.breakdown, result.finalPct),
    ]);
  }

  if (rows.length === 0) return;

  // Flatten into a single $1...$N param list. 8 columns per row.
  const COLS = 8;
  const valuePlaceholders = rows
    .map((_, rowIdx) => {
      const base = rowIdx * COLS;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    })
    .join(', ');
  const params = rows.flat();

  await pool.query(
    `INSERT INTO compatibility_scores
       (user_a, user_b, score, is_hard_blocked, is_soft_blocked, shadow_penalty, breakdown, why_matched)
     VALUES ${valuePlaceholders}
     ON CONFLICT (user_a, user_b) DO UPDATE
     SET score          = EXCLUDED.score,
         is_hard_blocked = EXCLUDED.is_hard_blocked,
         is_soft_blocked = EXCLUDED.is_soft_blocked,
         shadow_penalty  = EXCLUDED.shadow_penalty,
         breakdown       = EXCLUDED.breakdown,
         why_matched     = EXCLUDED.why_matched,
         calculated_at   = NOW()`,
    params,
  );
}

module.exports = router;
