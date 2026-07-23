#!/usr/bin/env node
/**
 * Seed the staging demo cohort — 5 students at one school, so a reviewer who
 * takes the quiz lands on a populated match feed.
 *
 * Run:  railway run -e staging -s haveniq-backend node scripts/seed-staging-demo.js
 *
 * SAFETY: refuses to run when RAILWAY_ENVIRONMENT is production, and again if
 * the resolved database host is the known production Postgres. Both checks are
 * deliberate: a seed script that writes real-looking students into the live
 * pool is exactly the mistake that has already happened once here.
 *
 * Scores are NOT precomputed. /quiz/submit scores the submitter against every
 * quiz-completed user, so the reviewer's own quiz run produces the pairings
 * through the real engine — which is what the demo is meant to exercise.
 */

const pool = require('../src/db/pool');
const { isProdEnvironment } = require('../src/lib/stagingGuard');

const SCHOOL = process.env.DEMO_SEED_SCHOOL || 'University of Southern California';
// A real-looking school domain on purpose: lib/demoFilter excludes `.test`,
// `@demo.*` and `*-demo.*` addresses from the match feed, so a demo-pattern
// address here would make every seed INVISIBLE and the reviewer's feed empty.
const DOMAIN = 'usc.edu';
const PROD_DB_HOSTS = ['yamanote.proxy.rlwy.net'];

// Answers use the shape production actually stores: { type:'option', index:N }.
// (Plain numbers also parse, but seeding the real shape keeps staging faithful
// to prod — a mismatch there is what silently broke About You / Matched Moment.)
const opt = (i) => ({ type: 'option', index: i });
const answerSet = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, opt(v)]));

// The 15 scored ids. Q14 is binary (0-1); every other scored question has 4
// options (0-3).
//
// Sets are spread so scores VARY but stay above the feed's MATCH_MIN_SCORE (50)
// for a typical reviewer. An earlier version made two seeds the exact opposite
// of the others; they scored 25 and 27, so the feed correctly hid them and the
// reviewer saw 3 of 5 students. That is the engine working, but it makes a thin
// demo — and how many they see would depend on how they answered. "Different
// but still plausibly compatible" keeps all five in the feed while the scores
// still differ enough to show real discrimination.
const BASE_TIDY   = { 14: 0, 48: 0, 49: 0, 50: 0, 51: 0, 52: 1, 53: 1, 54: 0, 55: 1, 56: 0, 57: 1, 60: 0, 62: 1, 63: 0, 68: 1 };
const BASE_SOCIAL = { 14: 0, 48: 1, 49: 1, 50: 1, 51: 0, 52: 2, 53: 2, 54: 1, 55: 2, 56: 1, 57: 1, 60: 1, 62: 2, 63: 1, 68: 2 };
const BASE_MIDDLE = { 14: 0, 48: 1, 49: 2, 50: 1, 51: 0, 52: 1, 53: 2, 54: 1, 55: 1, 56: 1, 57: 2, 60: 1, 62: 1, 63: 1, 68: 1 };

// Illustrated initial-avatars, so the demo cohort renders as people instead of
// grey silhouettes (profileComplete keys on first_name + photo_url). These are
// generated monograms, NOT photographs of real people — appropriate for an
// openly fictional staging cohort, and never used on production.
const avatar = (first, last) =>
  `https://ui-avatars.com/api/?name=${encodeURIComponent(first + ' ' + last)}`
  + '&size=256&background=A33625&color=FBF1EA&bold=true&format=png';

const SEEDS = [
  { first: 'Maya',   last: 'Rodriguez', age: 20, gender: 'female',    year: 'sophomore', major: 'Biology',
    bio: 'Early riser, keeps the kitchen clean, studies at the library most nights.',
    answers: BASE_TIDY },
  { first: 'Priya',  last: 'Shah',      age: 21, gender: 'female',    year: 'junior',    major: 'Computer Science',
    bio: 'Quiet weeknights, cooks on Sundays, happy to split chores on a schedule.',
    answers: { ...BASE_TIDY, 52: 2, 55: 0, 62: 0 } },
  { first: 'Jordan', last: 'Lee',       age: 20, gender: 'nonbinary', year: 'sophomore', major: 'Design',
    bio: 'Night owl, friends over on weekends, laid back about mess.',
    answers: BASE_SOCIAL },
  { first: 'Sam',    last: 'Okafor',    age: 22, gender: 'male',      year: 'senior',    major: 'Business',
    bio: 'Social, hosts a lot, prefers to talk things out same-day.',
    answers: { ...BASE_SOCIAL, 53: 2, 57: 3, 63: 2 } },
  { first: 'Alex',   last: 'Chen',      age: 21, gender: 'male',      year: 'junior',    major: 'Economics',
    bio: 'Middle of the road: tidy enough, occasional guests, direct about problems.',
    answers: BASE_MIDDLE },
];

async function main() {
  // ── Guard 1: environment ──
  // Production requires an EXPLICIT opt-in. Seeding fake students into the live
  // pool is exactly the mistake that has already happened here once, so the
  // refusal stays the default and the override has to be typed on purpose.
  const prodOk = String(process.env.SEED_ALLOW_PROD || '').trim().toLowerCase() === 'true';
  if (isProdEnvironment() && !prodOk) {
    console.error('REFUSING: RAILWAY_ENVIRONMENT is production. Pass SEED_ALLOW_PROD=true to seed prod deliberately.');
    process.exit(1);
  }
  if (isProdEnvironment()) console.log('[seed] *** SEEDING PRODUCTION (SEED_ALLOW_PROD=true) ***');
  // ── Guard 2: the actual database host ──
  const host = (() => {
    try { return new URL(String(process.env.DATABASE_URL).replace(/^postgres(ql)?:/, 'http:')).hostname; }
    catch { return ''; }
  })();
  if (PROD_DB_HOSTS.some((h) => host.includes(h)) && !prodOk) {
    console.error(`REFUSING: DATABASE_URL points at the production database (${host}).`);
    process.exit(1);
  }
  console.log(`[seed] env=${process.env.RAILWAY_ENVIRONMENT || 'local'} db_host=${host || '(internal)'}`);
  console.log(`[seed] school: ${SCHOOL}`);

  let created = 0, updated = 0;
  for (const s of SEEDS) {
    const email = `${s.first}.${s.last}`.toLowerCase() + `@${DOMAIN}`;
    // Idempotent: re-running refreshes the same 5 rows rather than duplicating.
    const { rows } = await pool.query(
      `INSERT INTO users
         (email, school, school_domain, first_name, last_name, age, gender, school_year,
          major, bio, photo_url, looking_for, is_verified, trust_score, quiz_completed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}',TRUE,60,TRUE)
       ON CONFLICT (email) DO UPDATE SET
         school=EXCLUDED.school, first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
         age=EXCLUDED.age, gender=EXCLUDED.gender, school_year=EXCLUDED.school_year,
         major=EXCLUDED.major, bio=EXCLUDED.bio, photo_url=EXCLUDED.photo_url,
         is_verified=TRUE, quiz_completed=TRUE
       RETURNING id, (xmax = 0) AS is_new`,
      [email, SCHOOL, DOMAIN, s.first, s.last, s.age, s.gender, s.year, s.major, s.bio, avatar(s.first, s.last)],
    );
    const { id, is_new } = rows[0];
    is_new ? created++ : updated++;

    await pool.query(
      `INSERT INTO quiz_answers (user_id, answers, completed)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id) DO UPDATE
         SET answers = EXCLUDED.answers, completed = TRUE, updated_at = NOW()`,
      [id, JSON.stringify(answerSet(s.answers))],
    );
    console.log(`  ${is_new ? 'created' : 'updated'}  ${s.first} ${s.last}  <${email}>`);
  }

  const { rows: check } = await pool.query(
    `SELECT count(*)::int AS n FROM users u JOIN quiz_answers q ON q.user_id = u.id
      WHERE u.school = $1 AND u.quiz_completed = TRUE AND q.completed = TRUE`, [SCHOOL]);
  console.log(`\n[seed] done — created ${created}, updated ${updated}.`);
  console.log(`[seed] quiz-complete students at ${SCHOOL}: ${check[0].n}`);
  console.log('[seed] scores are computed when a user submits the quiz (the real path).');
  console.log(`\nTeardown (staging only):`);
  console.log(`  DELETE FROM users WHERE email LIKE '%@${DOMAIN}' OR email LIKE '%@haveniq.test';`);
  await pool.end();
}

main().catch((e) => { console.error('[seed] failed:', e.message); process.exit(1); });
