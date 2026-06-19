// src/db/seedDemoMatchable.js
//
// Make a seeded demo pool (@haveniq-demo.edu) genuinely live-matchable for the
// founder, so the real matches feed + the in-quiz Q10 preview populate without
// any preview flag. Idempotent + demo-only — real students never see demo
// accounts (the /matches/feed demo filter hides them).
//
// Steps (each idempotent):
//   1. CREATE a ~30-user demo cohort if it doesn't exist (a chunk at the
//      founder's school so they read as realistic same-school matches), with
//      photos + recent last-active so presence shows.
//   2. Give each demo a VALID, varied quiz-answer set from the REAL questions
//      (correct sparse ids + per-question option counts → realistic scores).
//   3. Generate founder↔demo compatibility_scores with the REAL engine so the
//      feed populates immediately — no quiz retake needed.

const pool = require('./pool');
const QUESTIONS = require('../data/quizQuestions');
const { calculateCompatibility, generateWhyMatched } = require('../services/scoring');
const { getFounderIds, getFounderEmails } = require('../utils/founders');

const FIRST = [
  'Maya', 'Jordan', 'Sofia', 'Noah', 'Priya', 'Olivia', 'Liam', 'Ava', 'Ethan',
  'Isabella', 'Mason', 'Mia', 'Lucas', 'Harper', 'Diego', 'Emma', 'Aiden', 'Zoe',
  'Leo', 'Nina', 'Owen', 'Camila', 'Eli', 'Ruby', 'Theo', 'Layla', 'Jonah', 'Iris',
  'Sage', 'Tobias',
];
const LAST = 'RTLMBKPSDCNWAHEGJFVOIYZQXU';
const GENDERS = ['Woman', 'Man', 'Nonbinary'];
const YEARS = ['Freshman', 'Sophomore', 'Junior', 'Senior'];
const MAJORS = ['Design', 'Business', 'Biology', 'Computer Science', 'Psychology',
  'Nursing', 'Communications', 'Engineering', 'Art History', 'Economics'];
const BIOS = [
  'Early riser, big on a clean kitchen. Coffee fixes everything.',
  'Night owl, quiet study vibes. Respect the headphones.',
  'Plants, playlists, and slow Sundays.',
  'Gym in the morning, library by night. Tidy but not uptight.',
  'Love cooking for people. Dishes done same day.',
  'Easygoing, just no surprise guests at 2am.',
  'Into film, thrifting, and keeping shared spaces calm.',
  'Studious during the week, down to explore on weekends.',
];
// Half at the founder's school so they show even with a school filter; the
// rest nearby for an "All schools" mix.
const OCC = ['Orange Coast College', 'cccd.edu'];
const OTHER_SCHOOLS = [
  ['UC Irvine', 'uci.edu'],
  ['Cal State Fullerton', 'fullerton.edu'],
  ['UCLA', 'ucla.edu'],
  ['UC San Diego', 'ucsd.edu'],
];
const COHORT = 30;

async function ensureDemoUsers() {
  for (let i = 0; i < COHORT; i++) {
    const email = `sample${String(i + 1).padStart(2, '0')}@haveniq-demo.edu`;
    const [school, domain] = i < 15 ? OCC : OTHER_SCHOOLS[i % OTHER_SCHOOLS.length];
    const first = FIRST[i % FIRST.length];
    const last = LAST[i % LAST.length];
    const gender = GENDERS[i % GENDERS.length];
    const year = YEARS[i % YEARS.length];
    const major = MAJORS[i % MAJORS.length];
    const bio = BIOS[i % BIOS.length];
    const age = 18 + (i % 6);
    const photo = `https://i.pravatar.cc/512?img=${1 + (i % 70)}`;
    // Recent, spread-out last-active so the "Active today / Nd ago" label shows.
    const lastActive = new Date(Date.now() - Math.round((i % 7) * 0.9 * 86400000)).toISOString();
    await pool.query(
      `INSERT INTO users
         (email, school, school_domain, first_name, last_name, bio, major, school_year,
          age, gender, looking_for, is_verified, quiz_completed, trust_score, photo_url, last_active_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,TRUE,85,$12,$13)
       ON CONFLICT (email) DO NOTHING`,
      [email, school, domain, first, last, bio, major, year, age, gender,
       ['Woman', 'Man', 'Nonbinary'], photo, lastActive],
    );
  }
}

// Deterministic, varied option index for a (userId, questionId) pair — FNV-1a
// over the pair, clamped to the question's option count.
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
  await ensureDemoUsers();

  const optionQs = QUESTIONS.filter(q => Array.isArray(q.options) && q.options.length > 1);

  // Demo users that don't yet have a quiz_answers row.
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

  await pool.query(
    `UPDATE users SET quiz_completed = TRUE
      WHERE email LIKE '%@haveniq-demo.edu' AND quiz_completed IS DISTINCT FROM TRUE`,
  );
  await pool.query(
    `UPDATE users
        SET photo_url = 'https://i.pravatar.cc/512?img=' || (1 + (abs(hashtext(id::text)) % 70))
      WHERE email LIKE '%@haveniq-demo.edu' AND (photo_url IS NULL OR photo_url = '')`,
  );

  // Founder↔demo scores via the REAL engine so the feed populates with no
  // retake. Founder by id OR email; ON CONFLICT DO NOTHING never clobbers a
  // real score.
  let pairs = 0;
  try {
    const founderIds = getFounderIds();
    const founderEmails = getFounderEmails();
    const { rows: founders } = await pool.query(
      `SELECT qa.user_id, qa.answers
         FROM quiz_answers qa
         JOIN users u ON u.id = qa.user_id
        WHERE qa.completed = TRUE
          AND (u.id::text = ANY($1) OR lower(u.email) = ANY($2))`,
      [founderIds, founderEmails],
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
           ON CONFLICT (user_a, user_b) DO UPDATE
             SET score = EXCLUDED.score,
                 is_hard_blocked = EXCLUDED.is_hard_blocked,
                 is_soft_blocked = EXCLUDED.is_soft_blocked,
                 shadow_penalty  = EXCLUDED.shadow_penalty,
                 breakdown       = EXCLUDED.breakdown,
                 why_matched     = EXCLUDED.why_matched,
                 calculated_at   = NOW()`,
          [a, b, r.finalPct, !!r.isHardBlocked, !!r.isSoftBlocked, r.shadowPenalty || 0,
           JSON.stringify(r.breakdown || {}), generateWhyMatched(r.breakdown, r.finalPct)],
        );
        pairs++;
      }
    }

    // Seed ONE demo conversation per founder, with their top-scored named
    // sample as the partner + a short realistic exchange — so the founder can
    // see the full chat experience (name, presence, messages) without waiting
    // for a real match to reply. Idempotent: conversation is UNIQUE(user_a,
    // user_b), and messages only seed when the conversation is newly created.
    for (const f of founders) {
      const partner = (await pool.query(
        `SELECT u.id FROM compatibility_scores cs
           JOIN users u ON u.id = (CASE WHEN cs.user_a = $1 THEN cs.user_b ELSE cs.user_a END)
          WHERE (cs.user_a = $1 OR cs.user_b = $1)
            AND u.email LIKE '%@haveniq-demo.edu'
            AND u.first_name IS NOT NULL AND u.first_name <> ''
          ORDER BY cs.score DESC LIMIT 1`,
        [f.user_id],
      )).rows[0];
      if (!partner) continue;
      const [ca, cb] = String(f.user_id) < String(partner.id)
        ? [f.user_id, partner.id] : [partner.id, f.user_id];
      const conv = (await pool.query(
        `INSERT INTO conversations (user_a, user_b) VALUES ($1, $2)
         ON CONFLICT (user_a, user_b) DO NOTHING RETURNING id`,
        [ca, cb],
      )).rows[0];
      if (conv) {
        const msgs = [
          [partner.id, "hey! saw we matched — your place sounds like my vibe. still looking?", true,  '26 hours'],
          [f.user_id,  "yeah! when are you hoping to move in?",                                 true,  '25 hours'],
          [partner.id, "aiming for fall. clean kitchen, quiet weeknights — that work for you?", false, '35 minutes'],
        ];
        for (const [sender, body, read, ago] of msgs) {
          await pool.query(
            `INSERT INTO messages (conversation_id, sender_id, body, read, created_at)
             VALUES ($1, $2, $3, $4, NOW() - $5::interval)`,
            [conv.id, sender, body, read, ago],
          );
        }
      }
    }
  } catch (err) {
    console.error('[seedDemoMatchable] founder↔demo scoring failed:', err.message);
  }

  return { demoUsers: COHORT, seededAnswers: demos.length, scoredPairs: pairs };
}

module.exports = { seedDemoMatchable };
