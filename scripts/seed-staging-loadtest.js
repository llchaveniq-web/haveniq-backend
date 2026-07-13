#!/usr/bin/env node
/**
 * Seed load-test users on STAGING and print their bearer tokens — plus the two
 * capacity diagnostics the launch load-test needs (max_connections + a real
 * EXPLAIN ANALYZE of GET /matches/feed).
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 *   1. Upserts N test users (default 4) on the configured database. They use
 *      the @haveniq-demo.edu domain, so the demo filter keeps them OUT of every
 *      real student's match feed — but they can still authenticate and hit
 *      /matches/feed themselves, which is all the load test needs.
 *   2. Mints a 7-day bearer JWT for each (identical claims to signToken:
 *      { userId }, HS256), so k6 can send `Authorization: Bearer <token>`.
 *   3. Runs `SHOW max_connections` and an `EXPLAIN (ANALYZE, BUFFERS)` of the
 *      exact /matches/feed driving query for the first seeded user, so you get
 *      the timing + whether it seq-scans without hand-running psql.
 *
 * ── SAFETY (this WRITES users — never run it against production) ─────────────
 *   Requires an explicit opt-in: ALLOW_TEST_SEED=true. It prints the target DB
 *   host first so you can confirm it's staging. Point DATABASE_URL + JWT_SECRET
 *   at the STAGING service's values (Railway → staging service → Variables).
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   DATABASE_URL='postgres://…staging…' \
 *   JWT_SECRET='<staging jwt secret>' \
 *   ALLOW_TEST_SEED=true \
 *   node scripts/seed-staging-loadtest.js [count]
 */

const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const COUNT  = Math.max(1, Math.min(20, parseInt(process.argv[2], 10) || 4));
const SCHOOL = process.env.LOADTEST_SCHOOL || 'University of Ohio';
const DOMAIN = 'haveniq-demo.edu'; // demo domain ⇒ excluded from real feeds

function die(msg) { console.error(`\n[seed-staging] ${msg}\n`); process.exit(1); }

if (process.env.ALLOW_TEST_SEED !== 'true') {
  die('Refusing to run: set ALLOW_TEST_SEED=true to confirm this is STAGING (it writes test users).');
}
if (!process.env.DATABASE_URL) die('DATABASE_URL is not set.');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  die('JWT_SECRET is missing or < 32 chars — must match the staging backend so tokens verify.');
}

// Show the operator which database they're about to write to (no credentials).
let host = '(unparseable)';
try { host = new URL(process.env.DATABASE_URL).host; } catch { /* leave default */ }
console.log(`\n[seed-staging] target DB host: ${host}`);
console.log(`[seed-staging] seeding ${COUNT} user(s), school="${SCHOOL}", domain=@${DOMAIN}\n`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

// A faithful copy of the GET /matches/feed driving query (src/routes/matches.js),
// params: [userId, looking_for[], gender, smokeFree=false]. Kept in sync by hand;
// if the route query changes materially, update this too.
const FEED_SQL = `
  SELECT cs.score, u.id, u.first_name
    FROM compatibility_scores cs
    JOIN users u ON (CASE WHEN cs.user_a = $1 THEN cs.user_b ELSE cs.user_a END = u.id)
    LEFT JOIN personality_profiles pp ON pp.user_id = u.id
    LEFT JOIN connect_requests cr ON (
      (cr.from_user = $1 AND cr.to_user = u.id) OR
      (cr.to_user = $1   AND cr.from_user = u.id))
    LEFT JOIN quiz_answers dq ON dq.user_id = u.id
   WHERE (cs.user_a = $1 OR cs.user_b = $1)
     AND cs.is_hard_blocked = FALSE
     AND u.is_paused = FALSE
     AND u.is_banned = FALSE
     AND u.quiz_completed = TRUE
     AND NOT EXISTS (
       SELECT 1 FROM user_blocks ub
       WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
          OR (ub.blocker_id = u.id AND ub.blocked_id = $1))
   ORDER BY cs.score DESC
   LIMIT 50`;

async function main() {
  const client = await pool.connect();
  try {
    const results = [];
    for (let i = 1; i <= COUNT; i++) {
      const email = `loadtest-${i}@${DOMAIN}`;
      // Inclusive gender prefs so the mutual-preference feed filter never
      // excludes candidates for these synthetic users.
      const { rows } = await client.query(
        `INSERT INTO users (email, school, school_domain, first_name, gender, looking_for,
                            is_verified, quiz_completed, roommate_status)
         VALUES ($1, $2, $3, $4, 'Prefer not to say', ARRAY['Man','Woman','Non-binary'],
                 TRUE, TRUE, 'actively_looking')
         ON CONFLICT (email) DO UPDATE
           SET quiz_completed = TRUE, is_verified = TRUE, school = EXCLUDED.school
         RETURNING id`,
        [email, SCHOOL, DOMAIN, `LoadTest${i}`],
      );
      const userId = rows[0].id;
      // Ensure a quiz_answers row exists (feed reads it best-effort; harmless if empty).
      await client.query(
        `INSERT INTO quiz_answers (user_id, answers) VALUES ($1, '{}'::jsonb)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      });
      results.push({ email, userId, token });
    }

    // ── Deliverables ─────────────────────────────────────────────────────────
    const mc = await client.query('SHOW max_connections');
    console.log('════════════════════════════════════════════════════════════');
    console.log('max_connections:', mc.rows[0].max_connections);

    console.log('\nEXPLAIN (ANALYZE, BUFFERS) — GET /matches/feed for', results[0].email);
    const plan = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS) ${FEED_SQL}`,
      [results[0].userId, ['Man', 'Woman', 'Non-binary'], 'Prefer not to say'],
    );
    console.log(plan.rows.map(r => '  ' + r['QUERY PLAN']).join('\n'));

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('BEARER TOKENS (Authorization: Bearer <token>):\n');
    for (const r of results) {
      console.log(`# ${r.email}  (userId ${r.userId})`);
      console.log(r.token + '\n');
    }
    console.log('Done. Feed candidate count depends on seeded compatibility_scores;');
    console.log('an empty feed still exercises the same joins/scan the pool test measures.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => die(err.stack || err.message));
