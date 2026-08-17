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

let auditCalls = [];
inject('../services/auditLog', {
  audit: async (req, action, details) => { auditCalls.push({ userId: req.user?.id, action, details }); },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/research', require('./research'));

const asStudent  = () => { currentUser = { id: 'student-9', email: 'student@ohio.edu' }; };
const asFounder  = () => { currentUser = { id: 'founder-1', email: 'founder@haveniq.org' }; };
const asResearch = () => { currentUser = { id: 'r-1', email: 'lab@uni.edu' }; };

test.beforeEach(() => { auditCalls = []; });

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
  // Both emitters present — that is the whole point of the dataset — but as
  // two DISTINCT pseudonyms, not the raw ids (see the de-identification
  // block below for the full pseudonymization contract).
  assert.equal(new Set(res.body.events.map(e => e.userId)).size, 2);
  assert.match(lastSql, /ORDER BY t ASC/);
});

// ── De-identification (the fix) ──
// Raw user_id/pair_id were trivially reversible by any research-role
// account via the ordinary GET /users/:id lookup every user already has.
// These lock: no raw id anywhere in the response, pseudonyms are STABLE
// (same real id -> same pseudonym every time, across both endpoints), and
// a real GET /research/... call is audit-logged with the REAL pairKey.
test('no raw user id or pair key ever appears in the timeline response', async () => {
  asFounder();
  const res = await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(A), 'real id A must not leak into the response');
  assert.ok(!body.includes(B), 'real id B must not leak into the response');
  assert.ok(!body.includes(PAIR_KEY), 'the real pairKey must not leak into the response');
});

test('the SAME real id always pseudonymizes to the SAME value (de-identified, not de-linked)', async () => {
  asFounder();
  const res1 = await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  const res2 = await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  assert.deepEqual(res1.body.events.map(e => e.userId), res2.body.events.map(e => e.userId));
  assert.equal(res1.body.pairKey, res2.body.pairKey);
});

test('the pseudonym is stable across BOTH research endpoints for the same real id', async () => {
  asFounder();
  const timeline = await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  const bulk = await request(app).get('/research/pair-events?since=0');
  const timelinePseudo = timeline.body.events.find(e => e.id === 'e1').userId;
  const bulkPseudo = bulk.body.events.find(e => e.id === 'e1').userId;
  assert.equal(timelinePseudo, bulkPseudo, 'the same underlying user must pseudonymize identically everywhere');
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

// ── Audit logging (the fix) ──
// This was the one surface described in its own comment as the highest
// re-identification risk in the app, and previously had ZERO audit trail.
test('reading the timeline is audit-logged with the REAL pairKey, by the caller', async () => {
  asFounder();
  await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].userId, 'founder-1');
  assert.equal(auditCalls[0].action, 'research.timeline.view');
  assert.equal(auditCalls[0].details.pairKey, PAIR_KEY, 'audit trail keeps the real key even though the response does not');
});

test('reading the bulk export is also audit-logged', async () => {
  asFounder();
  await request(app).get('/research/pair-events?since=100&limit=2');
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].action, 'research.pairEvents.export');
  assert.deepEqual(auditCalls[0].details, { since: 100, limit: 2 });
});

test('a 403 (unauthorized) request is never audit-logged as a real access', async () => {
  asStudent();
  await request(app).get(`/research/pairs/${PAIR_KEY}/timeline`);
  assert.equal(auditCalls.length, 0, 'requireResearch runs before the handler, so a blocked request never reaches audit()');
});
