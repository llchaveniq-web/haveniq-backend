// POST /quiz/preview-cohort — the anonymous quiz-taker's proof-of-pool.
//
// This endpoint exists to close the app's biggest funnel leak: an anonymous
// first-time taker is asked for ten answers before seeing any evidence the
// product works, while every competitor shows inventory first. It answers the
// one question that can be answered safely — "how many real students already
// match how you live?" — and it must do so WITHOUT ever leaking a person.
//
// The invariants below are all privacy- or honesty-load-bearing:
//
//   1. AGGREGATE ONLY — no ids, names, photos, schools or per-person scores
//      may appear in the response body. Ever, for any caller.
//   2. k-ANONYMITY FLOOR — under MIN_COHORT (8) compatible students it returns
//      { cohort: null } instead of a small, narrowable number.
//   3. BUCKETS, NOT COUNTS — the label is coarse, so varying one answer at a
//      time can't be used to difference out an individual.
//   4. REAL POOL ONLY — demo/seed accounts are excluded, so the number is
//      never padded to make a quiet campus look busy.
//   5. Paused and banned accounts are excluded, matching every other
//      pool-reading query in the codebase.
//
// Pool stubbed; the real scoring engine runs. node --test.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Fixtures ──────────────────────────────────────────────────────────────
let candidateRows = [];
let lastSql = '';

inject('../db/pool', {
  query: async (sql, params = []) => {
    lastSql = sql;
    if (/FROM quiz_answers qa/i.test(sql)) return { rows: candidateRows };
    return { rows: [] };
  },
});

// Anonymous caller — optionalAuth leaves req.user undefined, which is the
// exact path this endpoint is built for.
inject('../middleware/auth', {
  requireAuth:  (req, res, next) => next(),
  optionalAuth: (req, res, next) => next(),
});

// Rate limiters are no-ops here; their behavior is covered by their own tests.
inject('../middleware/rateLimits', new Proxy({}, {
  get: () => (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/quiz', require('./quiz'));

// An answer set and a pool built to agree with it, so the real scorer returns
// high compatibility. Ids are real quiz question ids used elsewhere in tests.
// Request payloads must use the wire shape validateAnswers enforces
// ({ type, index }); stored rows may be either, since normalize() flattens both.
const RAW = { 48: 2, 49: 0, 14: 1, 12: 2, 15: 1, 22: 0 };
const ME = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, { type: 'option', index: v }]),
);
const twin  = () => ({ answers: { ...RAW } });
const clones = (n) => Array.from({ length: n }, twin);

test.beforeEach(() => { candidateRows = []; lastSql = ''; });

// ── 1. Never leaks identity ───────────────────────────────────────────────
test('response is aggregate only — no identity fields for any pool size', async () => {
  candidateRows = clones(120);
  const res = await request(app).post('/quiz/preview-cohort').send({ answers: ME });
  assert.equal(res.status, 200);
  const keys = Object.keys(res.body);
  assert.deepEqual(keys.sort(), ['cohort', 'compatible'],
    'only the bucket label and its count may be returned');
  const body = JSON.stringify(res.body);
  for (const leak of ['userId', 'firstName', 'lastInitial', 'photoUrl', 'school', 'email', 'matches']) {
    assert.ok(!body.includes(leak), `must not leak ${leak}`);
  }
});

// ── 2. k-anonymity floor ──────────────────────────────────────────────────
test('under the k-anonymity floor it returns null, not a small number', async () => {
  candidateRows = clones(5);           // < MIN_COHORT (8)
  const res = await request(app).post('/quiz/preview-cohort').send({ answers: ME });
  assert.equal(res.status, 200);
  assert.equal(res.body.cohort, null, 'a tiny cohort must not be described');
  assert.equal(res.body.compatible, 0, 'and its size must not be reported either');
});

test('exactly at the floor it speaks, in the coarsest bucket', async () => {
  candidateRows = clones(8);
  const res = await request(app).post('/quiz/preview-cohort').send({ answers: ME });
  assert.equal(res.body.cohort, 'a handful');
});

// ── 3. Buckets, not counts ────────────────────────────────────────────────
test('bucket labels are coarse and monotonic across pool sizes', async () => {
  const seen = [];
  for (const n of [10, 25, 50, 100]) {
    candidateRows = clones(n);
    const res = await request(app).post('/quiz/preview-cohort').send({ answers: ME });
    seen.push(res.body.cohort);
  }
  assert.deepEqual(seen, ['10+', '25+', '50+', '100+']);
});

test('one extra compatible student cannot move the bucket (differencing guard)', async () => {
  candidateRows = clones(40);
  const a = (await request(app).post('/quiz/preview-cohort').send({ answers: ME })).body.cohort;
  candidateRows = clones(41);
  const b = (await request(app).post('/quiz/preview-cohort').send({ answers: ME })).body.cohort;
  assert.equal(a, b, 'a single-person delta must be invisible in the label');
});

// ── 4 + 5. Real, active pool only ─────────────────────────────────────────
test('the pool query excludes demo, paused and banned accounts', async () => {
  candidateRows = clones(20);
  await request(app).post('/quiz/preview-cohort').send({ answers: ME });
  assert.match(lastSql, /qa\.completed = TRUE/i, 'only completed quizzes count');
  assert.match(lastSql, /u\.is_paused = FALSE/i);
  assert.match(lastSql, /u\.is_banned = FALSE/i);
  // notDemo() emits pattern-based ILIKE clauses rather than a literal domain,
  // so assert the construct it actually generates (see lib/demoFilter.js).
  assert.match(lastSql, /NOT \(/i, 'a negated demo predicate must be present');
  assert.match(lastSql, /-demo\./i, 'the seeded-cohort domain pattern must be excluded');
  assert.match(lastSql, /ILIKE/i);
});

// ── Guards on thin input ──────────────────────────────────────────────────
test('too few answers says nothing rather than something shaky', async () => {
  candidateRows = clones(50);
  const res = await request(app).post('/quiz/preview-cohort').send({ answers: { 48: { type: 'option', index: 2 } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.cohort, null);
});

test('an empty real pool returns the honest null, not a zero-dressed bucket', async () => {
  candidateRows = [];
  const res = await request(app).post('/quiz/preview-cohort').send({ answers: ME });
  assert.equal(res.status, 200);
  assert.equal(res.body.cohort, null);
  assert.equal(res.body.compatible, 0);
});

test('a malformed answers payload is rejected, not scored', async () => {
  candidateRows = clones(50);
  const res = await request(app).post('/quiz/preview-cohort').send({ answers: 'not-an-object' });
  assert.ok(res.status === 400 || res.body.cohort === null,
    'invalid input must never produce a cohort claim');
});
