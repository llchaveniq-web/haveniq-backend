#!/usr/bin/env node
/**
 * Deterministic load-test seeder — populates a STAGING database so the hot read
 * paths (especially GET /matches/feed) are as heavy as they'll be at launch,
 * then mints bearer tokens for the browse scenario.
 *
 * ── WHAT IT CREATES (all deterministic for a given SEED) ─────────────────────
 *   • ~2,000 users at ONE school (the launch campus), each with:
 *       - a completed quiz  (row in quiz_answers, completed=TRUE)
 *       - a photo_url placeholder + realistic budget / move-in / neighborhoods
 *         so the feed's viability + gender-preference filters actually run
 *   • compatibility_scores connecting the ~5 VIEWER users (whose tokens the
 *     ramp uses) to a large slice of the pool, so each token's /matches/feed
 *     returns a full page — the query does the real joins + sort + LIMIT 50,
 *     not a trivial empty scan. (Without this the feed is artificially fast.)
 *   • a few thousand connect_requests in mixed pending/accepted states between
 *     users, so the feed's connect_requests LEFT JOIN + the added
 *     idx_requests_from on connect_requests(from_user) are exercised.
 *
 *   The seeded users use a NON-demo domain (default @loadtest.ohio.edu) on
 *   PURPOSE: the /matches/feed demo filter HIDES @haveniq-demo.edu accounts
 *   from non-founder viewers, which would make every test feed empty. On a
 *   dedicated staging DB, populating the feed with test users is the goal.
 *
 * ── SAFETY (writes lots of rows — staging only) ─────────────────────────────
 *   Requires ALLOW_TEST_SEED=true and prints the target DB host first. Point
 *   DATABASE_URL + JWT_SECRET at the STAGING service's values. NEVER run against
 *   production (non-demo seeded users WOULD surface in real feeds there).
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   DATABASE_URL='postgres://…staging…' JWT_SECRET='<staging secret>' \
 *   ALLOW_TEST_SEED=true node scripts/seed-loadtest.js
 *
 *   Env knobs: USER_COUNT=2000  VIEWER_COUNT=5  CONNECT_COUNT=3000
 *              SCORES_PER_VIEWER=800  SEED=1337
 *              SEED_SCHOOL='Ohio University'  SEED_EMAIL_DOMAIN='loadtest.ohio.edu'
 */

const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

// ── Config ──────────────────────────────────────────────────────────────────
const USER_COUNT        = int(process.env.USER_COUNT, 2000);
const VIEWER_COUNT      = int(process.env.VIEWER_COUNT, 5);
const CONNECT_COUNT     = int(process.env.CONNECT_COUNT, 3000);
const SCORES_PER_VIEWER = int(process.env.SCORES_PER_VIEWER, 800);
const SEED              = int(process.env.SEED, 1337);
const SCHOOL            = process.env.SEED_SCHOOL || 'Ohio University';
const EMAIL_DOMAIN      = process.env.SEED_EMAIL_DOMAIN || 'loadtest.ohio.edu';
const MATCH_MIN_SCORE   = int(process.env.MATCH_MIN_SCORE, 40); // feed floor (mirror matchConfig)

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function die(msg) { console.error(`\n[seed-loadtest] ${msg}\n`); process.exit(1); }

if (process.env.ALLOW_TEST_SEED !== 'true') {
  die('Refusing to run: set ALLOW_TEST_SEED=true to confirm this is STAGING (it writes ~2k users + scores).');
}
if (!process.env.DATABASE_URL) die('DATABASE_URL is not set.');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  die('JWT_SECRET missing or < 32 chars — must match the staging backend so tokens verify.');
}

let host = '(unparseable)';
try { host = new URL(process.env.DATABASE_URL).host; } catch { /* keep default */ }
console.log(`\n[seed-loadtest] target DB host: ${host}`);
console.log(`[seed-loadtest] SEED=${SEED}  users=${USER_COUNT}  viewers=${VIEWER_COUNT}  ` +
            `connects=${CONNECT_COUNT}  scores/viewer=${SCORES_PER_VIEWER}`);
console.log(`[seed-loadtest] school="${SCHOOL}"  domain=@${EMAIL_DOMAIN}\n`);

// ── Deterministic PRNG (mulberry32) so every run with the same SEED is identical
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const FIRST = ['Alex','Sam','Jordan','Taylor','Casey','Riley','Morgan','Jamie','Avery','Quinn',
               'Devon','Skyler','Rowan','Parker','Reese','Hayden','Emerson','Finley','Kai','Sage'];
const GENDERS = ['Man','Woman','Non-binary','Prefer not to say'];
const LOOKING = [['Man'],['Woman'],['Non-binary'],['Man','Woman'],['Man','Woman','Non-binary']];
const MOVEIN  = ['1 month','2 months','3 months','Flexible'];
const HOODS   = ['Court Street','The Ridges','Mill Street','East Green','West Side','Uptown'];
const STATUS  = ['actively_looking','open_to_offers'];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();
  try {
    console.log('[seed-loadtest] inserting users + quiz answers…');
    const ids = new Array(USER_COUNT);
    // Batched multi-row inserts keep this to a few dozen round-trips, not 2,000.
    const BATCH = 200;
    for (let start = 0; start < USER_COUNT; start += BATCH) {
      const end = Math.min(start + BATCH, USER_COUNT);
      const vals = [];
      const params = [];
      let p = 1;
      for (let i = start; i < end; i++) {
        const bmin = between(600, 1000);
        const bmax = bmin + between(300, 900);
        vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::text[],$${p++},$${p++},$${p++},$${p++},$${p++}::text[],TRUE,FALSE,TRUE)`);
        params.push(
          `loadtest-${i}@${EMAIL_DOMAIN}`,      // email
          SCHOOL,                                // school
          EMAIL_DOMAIN,                          // school_domain
          `${pick(FIRST)}${i}`,                  // first_name
          pick(GENDERS),                         // gender
          pick(LOOKING),                         // looking_for text[]
          `https://picsum.photos/seed/hq${i}/400/400`, // photo_url placeholder
          bmin, bmax,                            // budget_min / budget_max
          pick(MOVEIN),                          // move_in_timeline
          [pick(HOODS), pick(HOODS)],            // neighborhoods text[]
        );
      }
      const { rows } = await client.query(
        `INSERT INTO users
           (email, school, school_domain, first_name, gender, looking_for,
            photo_url, budget_min, budget_max, move_in_timeline, neighborhoods,
            is_verified, is_paused, quiz_completed)
         VALUES ${vals.join(',')}
         ON CONFLICT (email) DO UPDATE
           SET quiz_completed = TRUE, is_paused = FALSE, school = EXCLUDED.school
         RETURNING id`,
        params,
      );
      for (let k = 0; k < rows.length; k++) ids[start + k] = rows[k].id;
    }

    // Quiz answers — one row per user. A varied but deterministic answer map so
    // the feed's answer-dependent filters (e.g. Q51 smoke) have real data.
    for (let start = 0; start < USER_COUNT; start += BATCH) {
      const end = Math.min(start + BATCH, USER_COUNT);
      const vals = [];
      const params = [];
      let p = 1;
      for (let i = start; i < end; i++) {
        const answers = {};
        for (const q of [1, 2, 3, 10, 20, 30, 40, 51]) answers[q] = between(0, 4);
        vals.push(`($${p++},$${p++}::jsonb,TRUE)`);
        params.push(ids[i], JSON.stringify(answers));
      }
      await client.query(
        `INSERT INTO quiz_answers (user_id, answers, completed)
         VALUES ${vals.join(',')}
         ON CONFLICT (user_id) DO UPDATE SET answers = EXCLUDED.answers, completed = TRUE`,
        params,
      );
    }

    // The first VIEWER_COUNT users are the token holders the ramp browses as.
    const viewers = ids.slice(0, VIEWER_COUNT);

    console.log('[seed-loadtest] scoring viewers against the pool…');
    // compatibility_scores for each viewer vs a large random slice of the pool.
    // Canonical ordering (user_a < user_b by UUID text) satisfies the CHECK.
    for (const v of viewers) {
      const targets = new Set();
      while (targets.size < Math.min(SCORES_PER_VIEWER, USER_COUNT - 1)) {
        const cand = ids[between(0, USER_COUNT - 1)];
        if (cand !== v) targets.add(cand);
      }
      const list = [...targets];
      for (let start = 0; start < list.length; start += BATCH) {
        const end = Math.min(start + BATCH, list.length);
        const vals = [];
        const params = [];
        let p = 1;
        for (let j = start; j < end; j++) {
          const a = v < list[j] ? v : list[j];
          const b = v < list[j] ? list[j] : v;
          // Scores span the feed floor so most pass MATCH_MIN_SCORE and the
          // feed returns a full LIMIT-50 page for every viewer.
          const score = (MATCH_MIN_SCORE + between(0, 100 - MATCH_MIN_SCORE)).toFixed(2);
          vals.push(`($${p++},$${p++},$${p++},FALSE)`);
          params.push(a, b, score);
        }
        await client.query(
          `INSERT INTO compatibility_scores (user_a, user_b, score, is_hard_blocked)
           VALUES ${vals.join(',')}
           ON CONFLICT (user_a, user_b) DO NOTHING`,
          params,
        );
      }
    }

    console.log('[seed-loadtest] seeding connect_requests (mixed states)…');
    // Random pairs, mixed pending/accepted. Bias many toward the viewers so
    // their feed's LEFT JOIN connect_requests returns real rows.
    for (let start = 0; start < CONNECT_COUNT; start += BATCH) {
      const end = Math.min(start + BATCH, CONNECT_COUNT);
      const vals = [];
      const params = [];
      let p = 1;
      for (let i = start; i < end; i++) {
        const from = (i % 3 === 0) ? pick(viewers) : ids[between(0, USER_COUNT - 1)];
        let to = ids[between(0, USER_COUNT - 1)];
        if (to === from) to = ids[(ids.indexOf(from) + 1) % USER_COUNT];
        const status = rnd() < 0.5 ? 'pending' : 'accepted';
        vals.push(`($${p++},$${p++},$${p++})`);
        params.push(from, to, status);
      }
      await client.query(
        `INSERT INTO connect_requests (from_user, to_user, status)
         VALUES ${vals.join(',')}
         ON CONFLICT (from_user, to_user) DO NOTHING`,
        params,
      );
    }

    // ── Mint viewer tokens for the ramp ──────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('TOKENS (comma-separate for the k6 TOKENS env):\n');
    const tokens = viewers.map(v =>
      jwt.sign({ userId: v }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }),
    );
    tokens.forEach((t, i) => console.log(`# loadtest-${i}@${EMAIL_DOMAIN}\n${t}\n`));
    console.log('TOKENS=' + tokens.join(','));
    console.log('════════════════════════════════════════════════════════════');

    const { rows: mc } = await client.query('SHOW max_connections');
    console.log(`\nmax_connections: ${mc[0].max_connections}`);
    console.log(`Seeded ${USER_COUNT} users, ${viewers.length} viewers scored vs up to ${SCORES_PER_VIEWER} each, ~${CONNECT_COUNT} connect_requests.`);
    console.log('Next: EXPLAIN ANALYZE the feed (scripts/seed-staging-loadtest.js prints it), then run k6-launch-loadtest.js.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => die(err.stack || err.message));
