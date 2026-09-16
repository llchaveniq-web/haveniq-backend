#!/usr/bin/env node
// ─── Run the campus-liquidity query against a real database ────────────────
//
//   DATABASE_URL=postgres://... node scripts/liquidity-check.js
//   node scripts/liquidity-check.js --seed      (build a fixture, then check)
//
// The backend's HTTP tests stub src/db/pool through the require cache, which
// is right for contract tests and means the SQL in src/lib/liquidity.js is
// never executed by them. A query that has never touched Postgres is not a
// verified query, so this runs it for real and prints what comes back.
//
// --seed writes a deliberately lopsided campus into the CURRENT database and
// is destructive (it truncates users and compatibility_scores). Point it at a
// scratch database, never at production; it refuses a URL that does not look
// like one.
const { Client } = require('pg');
const { ENGINE_FLOOR, LIQUIDITY_FLOOR, LIQUIDITY_SQL } = require('../src/lib/liquidity');
const { MATCH_MIN_SCORE } = require('../src/lib/matchConfig');

const SEED = process.argv.includes('--seed');
const URL = process.env.DATABASE_URL;

// The fixture the mutation matrix in the commit message is built from: twelve
// men seeking men and three women seeking women, every pair scored well above
// the feed floor. Fifteen quiz-complete students on one campus, which is what
// the old per-campus number reports, and no suite is possible for any woman.
const SEED_SQL = `
  TRUNCATE users, compatibility_scores, user_blocks CASCADE;
  INSERT INTO users (email, school, school_domain, first_name, gender, looking_for, quiz_completed, is_paused)
  SELECT 'm' || i || '@ohio.edu', 'Ohio University', 'ohio.edu', 'M' || i, 'Man', ARRAY['Man'], TRUE, FALSE
    FROM generate_series(1, 12) i;
  INSERT INTO users (email, school, school_domain, first_name, gender, looking_for, quiz_completed, is_paused)
  SELECT 'w' || i || '@ohio.edu', 'Ohio University', 'ohio.edu', 'W' || i, 'Woman', ARRAY['Woman'], TRUE, FALSE
    FROM generate_series(1, 3) i;
  INSERT INTO compatibility_scores (user_a, user_b, score, is_hard_blocked)
  SELECT a.id, b.id, 60.00, FALSE FROM users a JOIN users b ON a.id < b.id;
`;

(async () => {
  if (!URL) { console.error('set DATABASE_URL'); process.exit(2); }
  if (SEED && /prod|railway|amazonaws|api\.haveniq/i.test(URL)) {
    console.error('--seed truncates tables and this URL looks like a real deployment. Refusing.');
    process.exit(2);
  }
  const c = new Client({ connectionString: URL });
  await c.connect();
  if (SEED) { await c.query(SEED_SQL); console.log('seeded the lopsided fixture\n'); }

  // The headline the dashboard showed before this metric existed, printed
  // alongside it, because the whole point is that the two disagree.
  const naive = await c.query(
    `SELECT school, COUNT(*)::int AS quiz_complete
       FROM users WHERE quiz_completed IS TRUE AND school <> '' GROUP BY school ORDER BY 2 DESC`);
  const { rows } = await c.query(LIQUIDITY_SQL, [MATCH_MIN_SCORE, ENGINE_FLOOR]);

  console.log('feed floor ' + MATCH_MIN_SCORE + ', engine floor ' + ENGINE_FLOOR
    + ', liquidity floor ' + LIQUIDITY_FLOOR + '\n');
  for (const r of rows) {
    const head = naive.rows.find(n => n.school === r.school);
    console.log(r.school);
    console.log('   quiz-complete on this campus : ' + (head ? head.quiz_complete : '?')
      + '   <- the number the dashboard used to show');
    console.log('   matchable cohort             : ' + r.cohort);
    console.log('   reachable, worst / p10 / med : ' + r.worst + ' / ' + r.p10 + ' / ' + r.median);
    console.log('   cannot form ONE suite        : ' + r.below_engine_floor + ' student(s)');
    console.log('   gap to a self-sustaining campus: ' + Math.max(0, LIQUIDITY_FLOOR - r.worst));
  }
  if (!rows.length) console.log('no campus has a matchable cohort yet');
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
