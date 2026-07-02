// ═══════════════════════════════════════════════════════════════════════════
//  End-to-end cohort simulation — validates the REAL matching engine + the
//  autonomous loops against a synthetic cohort.
//
//  HARD SAFETY RULE — never production. Refuses if NODE_ENV=production or the
//  Railway environment id/name is production (the authoritative signal; staging
//  legitimately runs NODE_ENV=production, so env-id is what we trust). The
//  DB-backed loop stage runs ONLY against (a) a localhost ephemeral DB, (b) a
//  Railway run whose env-id is verified staging + SIM_ALLOW_STAGING=1, or (c) a
//  staging Postgres reached via a Railway TCP proxy (*.rlwy.net) with
//  SIM_ALLOW_STAGING=1 — production has no proxy, so a proxy host is staging.
//  Anything else → the DB stage is skipped, never touched. Seeded accounts use
//  @demo.haveniq.test; the lifecycle run gets a CAPTURING sendEmail, so NO real
//  email is ever sent; teardown deletes every seeded row in a `finally` (and on
//  failure), leaving staging clean.
//
//  Run (scoring + calibration only, no DB):   node scripts/cohort-sim.js
//  Run (full, local ephemeral PG):  DATABASE_URL=postgres://…@localhost:5432/… node scripts/cohort-sim.js
//  Run (full, against STAGING) — two safe ways:
//    • inside Railway staging:  SIM_ALLOW_STAGING=1 node scripts/cohort-sim.js
//        (RAILWAY_ENVIRONMENT_ID must be staging's; production is refused)
//    • via staging's TCP proxy:  SIM_ALLOW_STAGING=1 \
//        DATABASE_URL=postgres://<user>:<pass>@<host>.proxy.rlwy.net:<port>/railway \
//        node scripts/cohort-sim.js
// ═══════════════════════════════════════════════════════════════════════════
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sim-only-secret-at-least-32-chars-xxxxxx';

const assert = require('assert');
const { calculateCompatibility } = require('../src/services/scoring');

const results = { scoring: {}, calibration: {}, loops: {}, failures: [] };
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS ${name}`); }
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); results.failures.push(name + (detail ? ' — ' + detail : '')); }
  return cond;
}

// ── SAFETY GATE ─────────────────────────────────────────────────────────────
// The staging and production DBs share the SAME connection string
// (postgres.railway.internal), so we do NOT trust the URL to tell them apart.
// The authoritative discriminator is the Railway environment id/name, which is
// injected only for a process running INSIDE the environment. Production is
// refused by env id/name; the DB stage runs ONLY for a local ephemeral DB or an
// env-id-verified staging run explicitly gated by SIM_ALLOW_STAGING=1.
const DB_URL = process.env.DATABASE_URL || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ENV_NAME = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || '';
const ENV_ID = process.env.RAILWAY_ENVIRONMENT_ID || '';
const PROD_ENV_ID = '22e8333a-d7be-4770-8482-9e0e16e66116';
const STAGING_ENV_ID = '3283ab4e-b3fb-453c-a443-9f4d5842499c';

// A verified-staging run requires the explicit opt-in AND the authoritative
// staging env-id AND name — never inferred from NODE_ENV or the (ambiguous) URL.
const isStagingInNetwork = process.env.SIM_ALLOW_STAGING === '1' && ENV_ID === STAGING_ENV_ID && ENV_NAME === 'staging';

// Production is refused by the AUTHORITATIVE signal (env id / name) — not
// overridable. NODE_ENV=production also refuses UNLESS we've positively verified
// the staging env-id (staging legitimately deploys with NODE_ENV=production).
if (ENV_ID === PROD_ENV_ID || ENV_NAME === 'production' || (NODE_ENV === 'production' && !isStagingInNetwork)) {
  console.error('\nREFUSING TO RUN: production (or unverified prod-mode) detected.');
  console.error(`  NODE_ENV=${NODE_ENV}  RAILWAY_ENVIRONMENT=${ENV_NAME || '(unset)'}  ENV_ID=${ENV_ID || '(unset)'}  verifiedStaging=${isStagingInNetwork}`);
  process.exit(2);
}
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
// Staging Postgres reached via a Railway public TCP proxy (*.rlwy.net). Only
// staging has a proxy (created explicitly on staging's Postgres service);
// production has none, so under SIM_ALLOW_STAGING=1 a rlwy.net host is staging.
const isStagingProxy = process.env.SIM_ALLOW_STAGING === '1' && /@[^/]*\.rlwy\.net[:/]/.test(DB_URL);
const RUN_DB = !!DB_URL && (isLocalDb || isStagingInNetwork || isStagingProxy);
const DB_TARGET = isLocalDb ? 'LOCAL ephemeral'
  : isStagingInNetwork ? 'Railway STAGING (env-id verified)'
  : isStagingProxy ? 'Railway STAGING (TCP proxy)' : 'none';

// ── SYNTHETIC COHORT (40 users, 3 schools, varied answers) ──────────────────
const SCHOOLS = ['Sim State University', 'Demo Tech', 'Test A&M'];
const clamp = (n) => Math.max(0, Math.min(3, n));
// 14 scored questions; 51 = smoke@home (0 never … 3 regularly).
const ARCH = {
  monk:     { 50:0, 49:0, 48:1, 53:0, 55:1, 54:0, 52:0, 51:0, 14:1, 57:0, 60:1, 63:0, 62:0, 56:2 },
  party:    { 50:3, 49:3, 48:3, 53:2, 55:3, 54:3, 52:3, 51:0, 14:0, 57:3, 60:2, 63:3, 62:2, 56:1 },
  nightowl: { 50:0, 49:3, 48:0, 53:0, 55:1, 54:1, 52:0, 51:0, 14:1, 57:0, 60:0, 63:1, 62:1, 56:1 },
  social:   { 50:1, 49:2, 48:2, 53:2, 55:2, 54:2, 52:1, 51:0, 14:1, 57:1, 60:1, 63:1, 62:1, 56:2 },
  moderate: { 50:1, 49:2, 48:1, 53:0, 55:1, 54:2, 52:1, 51:0, 14:1, 57:1, 60:0, 63:2, 62:1, 56:1 },
  frugal:   { 50:0, 49:1, 48:0, 53:1, 55:0, 54:0, 52:0, 51:0, 14:1, 57:0, 60:1, 63:0, 62:1, 56:0 },
  studious: { 50:0, 49:1, 48:0, 53:0, 55:1, 54:0, 52:0, 51:0, 14:1, 57:1, 60:0, 63:1, 62:0, 56:1 },
};
const PERTURB_QS = [50, 49, 48, 53, 55, 54, 52, 57, 60, 63, 62, 56]; // never 51(smoke)/14(binary)

// Deterministic cohort: fixed pairs first, then deterministic perturbations.
const users = [];
function add(archetype, answers, tag) {
  const i = users.length;
  users.push({
    idx: i, archetype, tag,
    email: `sim.user${i}@demo.haveniq.test`,
    firstName: `Sim${i}`, school: SCHOOLS[i % 3],
    answers,
  });
}
add('monk', { ...ARCH.monk }, 'near-dup-A');                 // 0  ┐ near-duplicate pair (expect HIGH)
add('monk', { ...ARCH.monk }, 'near-dup-A');                 // 1  ┘
add('party', { ...ARCH.party }, 'near-dup-B');               // 2  ┐ near-duplicate pair (expect HIGH)
add('party', { ...ARCH.party }, 'near-dup-B');               // 3  ┘  (also OPPOSITE of 0/1)
add('monk', { ...ARCH.monk, 51: 3 }, 'smoker');              // 4  monk-but-SMOKER → dealbreaker vs 0
add('party', { ...ARCH.party, 51: 3 }, 'smoker');            // 5  party-but-SMOKER
const cycle = ['nightowl', 'social', 'moderate', 'frugal', 'studious', 'monk', 'party'];
for (let i = 6; i < 40; i++) {
  const arch = cycle[i % cycle.length];
  const a = { ...ARCH[arch] };
  const q = PERTURB_QS[(i * 5) % PERTURB_QS.length];
  a[q] = clamp(a[q] + ((i % 3) - 1));   // -1/0/+1, deterministic
  a[51] = 0;                            // ensure non-smoker (isolate the smoking test)
  add(arch, a, 'varied');
}

const toWire = (map) => { const o = {}; for (const [q, i] of Object.entries(map)) o[q] = { type: 'option', index: i }; return o; };
const score = (a, b, opts) => calculateCompatibility(toWire(a.answers), toWire(b.answers), opts || {});

// ── PART 1: SCORING E2E (pure, no DB) ───────────────────────────────────────
function runScoring() {
  console.log('\n=== PART 1 — matching engine (real scoring path) ===');
  const N = users.length;
  let pairs = 0, minS = 101, maxS = -1;
  let symOk = true, rangeOk = true, finiteOk = true;
  const matrix = [];
  for (let i = 0; i < N; i++) {
    matrix[i] = [];
    for (let j = 0; j < N; j++) {
      if (i === j) { matrix[i][j] = null; continue; }
      const s = score(users[i], users[j]).finalPct;
      matrix[i][j] = s;
      if (i < j) {
        pairs++;
        if (!(Number.isFinite(s))) finiteOk = false;
        if (!(s >= 0 && s <= 100)) rangeOk = false;
        if (s < minS) minS = s; if (s > maxS) maxS = s;
      }
    }
  }
  // symmetry: score(i,j) === score(j,i)
  for (let i = 0; i < N && symOk; i++) for (let j = i + 1; j < N; j++) if (matrix[i][j] !== matrix[j][i]) { symOk = false; break; }
  // determinism: re-run the whole matrix, compare
  let detOk = true;
  for (let i = 0; i < N && detOk; i++) for (let j = i + 1; j < N; j++) if (score(users[i], users[j]).finalPct !== matrix[i][j]) { detOk = false; break; }

  const dupA = matrix[0][1], dupB = matrix[2][3];
  const opp = matrix[0][2];                          // monk vs party
  const smoke = score(users[0], users[4]);           // non-smoker × smoker
  // ranking: user 0's best match should be its near-duplicate (user 1)
  let bestJ = -1, bestS = -1;
  for (let j = 1; j < N; j++) if (matrix[0][j] > bestS) { bestS = matrix[0][j]; bestJ = j; }

  results.scoring = { pairs, minS, maxS, dupA, dupB, opp, smoke: smoke.finalPct, smokeCap: smoke.capReason, bestJ, bestS };
  check(`scored all ${pairs} unordered pairs`, pairs === (N * (N - 1)) / 2);
  check('every finalPct is finite (no NaN/undefined)', finiteOk);
  check(`every finalPct in [0,100] (observed ${minS}..${maxS})`, rangeOk);
  check('symmetric: score(A,B) === score(B,A)', symOk);
  check('deterministic: identical re-run', detOk);
  check(`near-duplicate pair A scores HIGH >80 (got ${dupA})`, dupA > 80, `pair 0×1`);
  check(`near-duplicate pair B scores HIGH >80 (got ${dupB})`, dupB > 80, `pair 2×3`);
  check(`opposites score LOW <40 (monk×party got ${opp})`, opp < 40, `pair 0×2`);
  check(`dealbreaker (smoking) excludes: capped <40 (got ${smoke.finalPct}, reason=${smoke.capReason})`,
    smoke.finalPct < 40 && smoke.capReason === 'smoking', `pair 0×4`);
  check(`ranking sane: user 0's top match is its near-dup user 1 (got user ${bestJ} @ ${bestS})`, bestJ === 1);
}

// ── PART 2: CALIBRATION bucketing (pure, no DB) ─────────────────────────────
function runCalibration() {
  console.log('\n=== PART 2 — outcome calibration bucketing ===');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'sim-only-secret-at-least-32-chars-xxxxxx';
  const { _calibration } = require('../src/routes/matchOutcomes');
  const { computeCalibration, bandFor } = _calibration;
  // Feed resolved retention outcomes (stage 'day60'); rating >= 4 = success
  // per the engine's isSuccess. Predicted score drives the band.
  const rows = [
    { predictedScore: 92, stage: 'day60', rating: 5 },  // 85–100 success
    { predictedScore: 88, stage: 'day60', rating: 4 },  // 85–100 success
    { predictedScore: 90, stage: 'day60', rating: 2 },  // 85–100 fail
    { predictedScore: 75, stage: 'day60', rating: 4 },  // 70–84 success
    { predictedScore: 60, stage: 'day60', rating: 2 },  // 55–69 fail
    { predictedScore: 30, stage: 'day60', rating: 1 },  // Below 55 fail
  ];
  const out = computeCalibration(rows);
  // Bands carry { min, sampleSize, actualSuccess }; key by min (ASCII-safe).
  const b = {}; for (const x of out.bands || []) b[x.min] = x;
  results.calibration = { totalSample: out.totalSample, bands: out.bands };
  const succ = (m) => b[m] && Math.round(b[m].actualSuccess * 1000);
  check('bandFor maps scores to the right band', bandFor(92).min === 85 && bandFor(75).min === 70 && bandFor(60).min === 55 && bandFor(30).min === 0);
  check(`totalSample counts all resolved outcomes (got ${out.totalSample})`, out.totalSample === 6);
  check(`85+ band: 3 outcomes, 2/3 success (got n=${b[85] && b[85].sampleSize}, rate=${succ(85)})`,
    b[85] && b[85].sampleSize === 3 && succ(85) === 667);
  check(`70–84 band: 1 outcome, 100% success (got n=${b[70] && b[70].sampleSize}, rate=${succ(70)})`,
    b[70] && b[70].sampleSize === 1 && succ(70) === 1000);
  check(`55–69 band: 1 outcome, 0% success (got n=${b[55] && b[55].sampleSize}, rate=${succ(55)})`,
    b[55] && b[55].sampleSize === 1 && succ(55) === 0);
  check(`below-55 band: 1 outcome, 0% success (got n=${b[0] && b[0].sampleSize}, rate=${succ(0)})`,
    b[0] && b[0].sampleSize === 1 && succ(0) === 0);
}

// ── PART 3: LOOP E2E (DB-backed: lifecycle targeting + digest funnel) ────────
async function runLoops() {
  console.log('\n=== PART 3 — autonomous loops (seeded staging DB) ===');
  const pool = require('../src/db/pool');
  // Group sizes engineered so each segment + funnel stage has known counts.
  const GROUPS = { quiz_incomplete: 10, matches_waiting: 8, invited_nobody: 12, referrers: 10 }; // = 40
  const seededIds = [];

  // Minimal schema for the LOCAL ephemeral case (no-op on staging, where the
  // real tables already exist). Columns mirror the real schema's NOT NULL set so
  // the same INSERTs satisfy both: users.school_domain, quiz_answers.answers,
  // compatibility_scores.score, referrals.referred_id.
  async function schema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT, first_name TEXT, school TEXT, school_domain TEXT,
        is_verified BOOLEAN DEFAULT FALSE, is_banned BOOLEAN DEFAULT FALSE,
        email_undeliverable BOOLEAN DEFAULT FALSE, lifecycle_opted_out BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(), last_active_at TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS quiz_answers (user_id UUID, answers JSONB, completed BOOLEAN, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS compatibility_scores (user_a UUID, user_b UUID, score NUMERIC);
      CREATE TABLE IF NOT EXISTS connect_requests (from_user UUID, to_user UUID, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS referrals (referrer_id TEXT, referred_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    `);
  }
  async function mkUser(u, { quiz, created }) {
    const r = await pool.query(
      `INSERT INTO users (email, first_name, school, school_domain, is_verified, created_at, last_active_at)
       VALUES ($1,$2,$3,'demo.haveniq.test',TRUE,$4,NOW()) RETURNING id`,
      [u.email, u.firstName, u.school, created]);
    const id = r.rows[0].id; seededIds.push(id);
    if (quiz !== undefined) {
      await pool.query('INSERT INTO quiz_answers (user_id, answers, completed) VALUES ($1, $2::jsonb, $3)', [id, '{}', quiz]);
    }
    return id;
  }
  async function seed() {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400e3).toISOString();
    let k = 0;
    const grp = {};
    for (const [name, n] of Object.entries(GROUPS)) {
      grp[name] = [];
      for (let i = 0; i < n; i++, k++) {
        const u = users[k];
        const quiz = name === 'quiz_incomplete' ? false : true;   // incomplete = no completed quiz
        grp[name].push(await mkUser(u, { quiz, created: threeDaysAgo }));
      }
    }
    // matches_waiting: give each a real compatibility_scores match (pair them up).
    for (let i = 0; i < grp.matches_waiting.length; i += 2) {
      const a = grp.matches_waiting[i], b = grp.matches_waiting[i + 1] || grp.matches_waiting[0];
      await pool.query('INSERT INTO compatibility_scores (user_a, user_b, score) VALUES ($1,$2,90.0)', [a, b]);
    }
    // referrers: each has >=1 referral (referred_id is NOT NULL + UNIQUE).
    for (const id of grp.referrers) {
      await pool.query('INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2)', [String(id), `simref-${id}`]);
    }
    return grp;
  }
  // Domain-scoped teardown — deletes ONLY the @demo.haveniq.test rows (and their
  // children), independent of run state, so it cleans even a partially-failed run
  // and never touches real data. Idempotent.
  async function teardown() {
    const inDemo = "(SELECT id FROM users WHERE email ILIKE '%@demo.haveniq.test')";
    try {
      await pool.query(`DELETE FROM quiz_answers WHERE user_id IN ${inDemo}`);
      await pool.query(`DELETE FROM compatibility_scores WHERE user_a IN ${inDemo} OR user_b IN ${inDemo}`);
      await pool.query(`DELETE FROM connect_requests WHERE from_user IN ${inDemo}`);
      await pool.query(`DELETE FROM referrals WHERE referrer_id IN (SELECT id::text FROM users WHERE email ILIKE '%@demo.haveniq.test')`);
      await pool.query("DELETE FROM lifecycle_sends WHERE email ILIKE '%@demo.haveniq.test'");
      await pool.query("DELETE FROM users WHERE email ILIKE '%@demo.haveniq.test'");
    } catch (e) { console.log('  (teardown note:', e.message, ')'); }
  }

  try {
    await schema();
    await teardown();                 // start clean (in case a prior run died)
    await seed();

    // Lifecycle: run the REAL job with a CAPTURING sendEmail (0 real emails) and
    // a raised cap so the whole cohort is processed (breaker tested separately).
    const captured = [];
    const lifecycle = require('../src/services/lifecycleSender');
    const r = await lifecycle.runLifecycle({
      enabled: true, config: { minAbs: 1000 },
      sendEmail: async (m) => { captured.push(m); },
    });
    results.loops.lifecycle = { bySegment: r.bySegment, sent: r.sent, planned: r.planned, paused: r.paused };
    const expect = { quiz_incomplete: 10, matches_waiting: 8, invited_nobody: 12 };
    check(`lifecycle targets the right users by segment ${JSON.stringify(r.bySegment)}`,
      JSON.stringify(r.bySegment) === JSON.stringify(expect));
    check(`lifecycle planned/sent = 30 (got planned=${r.planned}, sent=${r.sent})`, r.planned === 30 && r.sent === 30);
    check('lifecycle sent 0 REAL emails (all captured, all @demo.haveniq.test)',
      captured.length === 30 && captured.every((m) => /@demo\.haveniq\.test$/.test(m.to)));
    check('every lifecycle email carries a one-click unsubscribe link',
      captured.every((m) => /\/unsubscribe\?token=/.test(m.text || '')));

    // Growth digest: the funnel must EQUAL the seeded reality (real, not faked).
    const digest = require('../src/services/growthDigest');
    const metrics = await digest.collectMetrics(pool, 20);
    const funnel = {}; for (const f of metrics.funnel) funnel[f.stage] = f.count;
    results.loops.funnel = funnel;
    const expectFunnel = { signup: 40, quiz: 30, match: 8, connect: 0, invite: 10 };
    check(`digest funnel EQUALS seeded reality ${JSON.stringify(funnel)}`,
      JSON.stringify(funnel) === JSON.stringify(expectFunnel));

    // Teardown + assert staging is clean.
    await teardown();
    const left = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE email ILIKE '%@demo.haveniq.test'");
    check(`teardown left 0 seeded users (got ${left.rows[0].n})`, left.rows[0].n === 0);
  } finally {
    await teardown();                 // guaranteed cleanup, even on failure
    await pool.end().catch(() => {});
  }
}

(async () => {
  console.log(`cohort-sim — NODE_ENV=${NODE_ENV}, RAILWAY_ENV=${ENV_NAME || '(none)'} id=${ENV_ID || '(none)'}`);
  console.log(`DB stage: ${RUN_DB ? 'WILL RUN against ' + DB_TARGET : 'SKIPPED (' + DB_TARGET + ')'}`);
  console.log(`cohort: ${users.length} users across ${SCHOOLS.length} schools`);
  try {
    runScoring();
    runCalibration();
    if (RUN_DB) await runLoops();
    else console.log('\n=== PART 3 — SKIPPED (no safe local DATABASE_URL; refusing anything non-local) ===');
  } catch (e) {
    console.error('\nSIM ERROR:', e.message);
    results.failures.push('exception: ' + e.message);
  }
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(results.failures.length ? `\nRESULT: ${results.failures.length} FAILURE(S)` : '\nRESULT: ALL CHECKS PASSED');
  process.exit(results.failures.length ? 1 : 0);
})();
