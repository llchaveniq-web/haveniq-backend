// src/db/seedDemoMatchable.js
//
// Make the seeded demo pool (@haveniq-demo.edu) genuinely live-matchable for
// the founder, so the real matches feed + the in-quiz Q10 preview populate
// without any preview flag. Idempotent + demo-only — real students never see
// demo accounts (the /matches/feed demo filter hides them).
//
// What it does (only for demo users that need it):
//   1. Generates a VALID, varied quiz-answer set from the REAL questions
//      (correct sparse ids + per-question option counts) so the scoring engine
//      produces realistic, varied scores — not garbage.
//   2. Marks them quiz-complete.
//   3. Gives them a college-aged placeholder photo.
//
// The founder↔demo compatibility_scores themselves are produced by the REAL
// engine the next time the founder submits/recomputes their quiz
// (scoreNewMatches scores against ALL completed users, demos included). The
// Q10 preview works immediately (it scores demos on the fly).

const pool = require('./pool');
const QUESTIONS = require('../data/quizQuestions');
const { calculateCompatibility, generateWhyMatched } = require('../services/scoring');
const { getFounderIds } = require('../utils/founders');

// Deterministic, varied option index for a (userId, questionId) pair — FNV-1a
// over the pair, clamped to the question's option count. Same demo user always
// gets the same answers (stable scores across reboots).
function pickIndex(userId, qid, nopts) {
  let h = 2166136261;
  const s = `${userId}:${qid}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % nopts;
}

async function seedDemoMatchable() {
  const optionQs = QUESTIONS.filter(q => Array.isArray(q.options) && q.options.length > 1);

  // Only demo users that don't already have a quiz_answers row.
  const { rows: demos } = await pool.query(
    `SELECT u.id
       FROM users u
       LEFT JOIN quiz_answers qa ON qa.user_id = u.id
      WHERE u.email LIKE '%@haveniq-demo.edu'
        AND qa.user_id IS NULL`,
  );

  for (const d of demos) {
    const answers = {};
    for (const q of optionQs) answers[q.id] = pickIndex(d.id, q.id, q.options.length);
    await pool.query(
      `INSERT INTO quiz_answers (user_id, answers, completed)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id) DO NOTHING`,
      [d.id, JSON.stringify(answers)],
    );
  }

  // Flag + photo (guarded so they're no-ops once set).
  await pool.query(
    `UPDATE users SET quiz_completed = TRUE
      WHERE email LIKE '%@haveniq-demo.edu' AND quiz_completed IS DISTINCT FROM TRUE`,
  );
  await pool.query(
    `UPDATE users
        SET photo_url = 'https://i.pravatar.cc/512?img=' || (1 + (abs(hashtext(id::text)) % 70))
      WHERE email LIKE '%@haveniq-demo.edu' AND (photo_url IS NULL OR photo_url = '')`,
  );

  // Generate founder↔demo compatibility_scores with the REAL engine so the
  // founder's normal matches feed populates immediately — no quiz retake
  // needed. Only for founder accounts (getFounderIds) that have completed the
  // quiz; demos are hidden from everyone else by the feed's demo filter.
  // ON CONFLICT DO NOTHING never overwrites a real score (e.g. if the founder
  // later retakes their quiz, their submit upserts the authoritative value).
  let pairs = 0;
  try {
    const founderIds = getFounderIds();
    const { rows: founders } = await pool.query(
      `SELECT user_id, answers FROM quiz_answers
        WHERE completed = TRUE AND user_id::text = ANY($1)`,
      [founderIds],
    );
    const { rows: demoAns } = await pool.query(
      `SELECT qa.user_id, qa.answers
         FROM quiz_answers qa
         JOIN users u ON u.id = qa.user_id
        WHERE u.email LIKE '%@haveniq-demo.edu' AND qa.completed = TRUE`,
    );
    for (const f of founders) {
      for (const dm of demoAns) {
        const r = calculateCompatibility(f.answers, dm.answers);
        const [a, b] = String(f.user_id) < String(dm.user_id)
          ? [f.user_id, dm.user_id]
          : [dm.user_id, f.user_id];
        await pool.query(
          `INSERT INTO compatibility_scores
             (user_a, user_b, score, is_hard_blocked, is_soft_blocked, shadow_penalty, breakdown, why_matched)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (user_a, user_b) DO NOTHING`,
          [a, b, r.finalPct, !!r.isHardBlocked, !!r.isSoftBlocked, r.shadowPenalty || 0,
           JSON.stringify(r.breakdown || {}), generateWhyMatched(r.breakdown, r.finalPct)],
        );
        pairs++;
      }
    }
  } catch (err) {
    console.error('[seedDemoMatchable] founder↔demo scoring failed:', err.message);
  }

  return { seededAnswers: demos.length, scoredPairs: pairs };
}

module.exports = { seedDemoMatchable };
