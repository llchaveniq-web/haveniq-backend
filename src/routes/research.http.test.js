// /research/* — the export that deliberately joins BOTH sides of a pairing.
// The access control is the non-negotiable part: a normal user token must never
// reach it, because one roommate's `signal` events are their own pulse. DB/auth
// stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// No env-designated researchers — so the default posture (founder only) is what
// these tests actually exercise.
delete process.env.RESEARCH_EMAILS;
delete process.env.RESEARCH_USER_IDS;
process.env.FOUNDER_USER_IDS = 'founder-1';
process.env.FOUNDER_EMAILS   = 'founder@haveniq.org';

const A = 'user-aaa', B = 'user-bbb';
const PAIR_KEY = [A, B].sort().join(':');

// Two sides of one pairing + one row from an unrelated pair.
const ROWS = [
  { id: 'e1', user_id: A, pair_id: B, pair_key: PAIR_KEY, t: '1700000000000', kind: 'signal',       subtype: 'pulse',            topic: 'guests', value: 2, meta: { raised: true }, created_at: 'c1' },
  { id: 'e2', user_id: B, pair_id: A, pair_key: PAIR_KEY, t: '1700000001000', kind: 'intervention', subtype: 'nudge_shown',      topic: 'guests', value: null, meta: null, created_at: 'c2' },
  { id: 'e3', user_id: A, pair_id: B, pair_key: PAIR_KEY, t: '1700000002000', kind: 'outcome',      subtype: 'repair_completed', topic: 'guests', value: null, meta: { outcome: 'ok' }, created_at: 'c3' },
];

let lastSql = '', lastParams = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT[\s\S]*FROM pair_events/.test(sql)) {
      lastSql = sql; lastParams = params;
      if (/pair_key = \$1/.test(sql)) {
        return { rows: ROWS.filter(r => r.pair_key === params[0]) };
      }
      return { rows: ROWS.filter(r => Number(r.t) >= Number(params[0])).slice(0, params[1]) };
    }
    return { rows: [], rowCount: 0 };
  },
});

let currentUser = { id: 'student-9', email: 'student@ohio.edu' };
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = currentUser; next(); },
  refuseBanned: (_req, _res, next) => next(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/research', require('./research'));

const asStudent  = () => { currentUser = { id: 'student-9', email: 'student@ohio.edu' }; };
const asFounder  = () => { currentUser = { id: 'founder-1', email: 'founder@haveniq.org' }; };
const asResearch = () => { currentUser = { id: 'r-1', email: 'lab@uni.edu' }; };

// ── Access control ──
test('a normal student token cannot read the timeline', async () => {
  asStudent();
  const res = await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Research access only');
});

test('a normal student token cannot read the bulk export', async () => {
  asStudent();
  assert.equal((await request(app).get('/research/pair-events?since=0')).status, 403);
});

test('a student cannot reach it by naming a pair they are in', async () => {
  // The dataset joins both sides; being a participant is NOT a grant.
  currentUser = { id: A, email: 'a@ohio.edu' };
  assert.equal((await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`)).status, 403);
});

test('the founder can read it', async () => {
  asFounder();
  assert.equal((await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`)).status, 200);
});

test('an env-designated researcher can read it; unset env grants nobody else', async () => {
  asResearch();
  assert.equal((await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`)).status, 403,
    'fails closed while RESEARCH_EMAILS is unset');
  process.env.RESEARCH_EMAILS = 'lab@uni.edu';
  assert.equal((await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`)).status, 200);
  delete process.env.RESEARCH_EMAILS;
});

// ── Timeline contract ──
test('the timeline joins BOTH sides of the pairing, ordered by t', async () => {
  asFounder();
  const res = await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  assert.equal(res.body.count, 3);
  assert.deepEqual(res.body.events.map(e => e.id), ['e1', 'e2', 'e3']);
  // Both emitters present — that is the whole point of the dataset.
  assert.deepEqual([...new Set(res.body.events.map(e => e.userId))].sort(), [A, B]);
  assert.match(lastSql, /ORDER BY t ASC/);
});

test('t is a number, so the set compares directly with the client export', async () => {
  asFounder();
  const res = await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  assert.strictEqual(res.body.events[0].t, 1700000000000);
});

test('the signal → intervention → outcome chain survives the round trip', async () => {
  asFounder();
  const res = await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  assert.deepEqual(res.body.events.map(e => e.kind), ['signal', 'intervention', 'outcome']);
  assert.equal(res.body.summary.pairCount, 1);
  assert.deepEqual(res.body.summary.kinds, { signal: 1, intervention: 1, outcome: 1 });
});

test('an unknown pair returns an honest empty timeline, not a 404 or a guess', async () => {
  asFounder();
  const res = await request(app).get('/research/pairs/nobody:nobody/timeline');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, []);
  assert.equal(res.body.count, 0);
});

// ── Bulk export ──
test('bulk export filters on the client clock and reports a watermark', async () => {
  asFounder();
  const res = await request(app).get('/research/pair-events?since=1700000001000');
  assert.equal(res.status, 200);
  assert.equal(res.body.since, 1700000001000);
  assert.deepEqual(res.body.events.map(e => e.id), ['e2', 'e3']);
  assert.equal(res.body.nextSince, 1700000002000);
});

test('a truncated page says so, so nobody analyses half a cohort as if it were whole', async () => {
  asFounder();
  const res = await request(app).get('/research/pair-events?since=0&limit=2');
  assert.equal(res.body.count, 2);
  assert.equal(res.body.truncated, true);
});

test('a full page is not flagged truncated', async () => {
  asFounder();
  const res = await request(app).get('/research/pair-events?since=0&limit=100');
  assert.equal(res.body.truncated, false);
});

test('a missing/garbage since defaults to the whole dataset', async () => {
  asFounder();
  assert.equal((await request(app).get('/research/pair-events')).body.since, 0);
  assert.equal((await request(app).get('/research/pair-events?since=abc')).body.since, 0);
});

test('vocabulary drift is surfaced rather than hidden', async () => {
  asFounder();
  const res = await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  assert.deepEqual(res.body.summary.unknownSubtypes, [], 'all known today');
});
