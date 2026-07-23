// Close the Loop — the pair ledger endpoints.
//
// The load-bearing properties: the timeline never reaches a normal user (it is
// two real people's conflict record), nothing is tracked without consent, and a
// client cannot choose its own experimental arm — if it could, the
// intervention-vs-control comparison would measure nothing. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.FOUNDER_USER_IDS = 'founder-1';
process.env.INTERNAL_API_KEY = 'internal-key-abcdef';

const A = 'user-aaa', B = 'user-bbb';
const PAIR = [A, B].sort().join(':');

let consented = new Set([PAIR]);
let stored = [];          // rows the service "persisted"
let timelineRows = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/FROM pair_consent/.test(sql)) return { rows: consented.has(params[0]) ? [{ '?column?': 1 }] : [] };
    if (/INSERT INTO pair_consent/.test(sql)) { consented.add(params[0]); return { rows: [] }; }
    if (/UPDATE pair_consent/.test(sql))      { consented.delete(params[0]); return { rows: [] }; }
    if (/INSERT INTO pair_events/.test(sql))  { stored.push(params); return { rowCount: 1 }; }
    if (/SELECT arm FROM pair_events/.test(sql)) {
      const prior = stored.find(p => p[10] === params[0] && p[11]);
      return { rows: prior ? [{ arm: prior[11] }] : [] };
    }
    if (/FROM pair_events/.test(sql)) return { rows: timelineRows };
    return { rows: [], rowCount: 0 };
  },
});

let currentUser = { id: A, email: 'a@ohio.edu' };
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = currentUser; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/pairs', require('./pairs'));

const INTERNAL = { 'x-internal-key': 'internal-key-abcdef' };
const asUser = (id) => { currentUser = { id, email: id + '@ohio.edu' }; };

const postEvent = (body, headers = {}) =>
  request(app).post(`/pairs/${PAIR}/events`).set(headers).send(body);
const getTimeline = (headers = {}) =>
  request(app).get(`/pairs/${PAIR}/timeline`).set(headers);

const evt = (over = {}) => ({
  id: over.id || 'e1',
  payload: {
    t: 1_700_000_000_000, kind: 'signal', subtype: 'pulse',
    topic: 'dishes', value: 2, ...(over.payload || {}),
  },
});

test.beforeEach(() => {
  stored = []; timelineRows = []; consented = new Set([PAIR]);
  asUser(A);
  require('../services/pairEvents')._resetTableReady();
});

// ── Privacy: the timeline is NOT a user-facing surface ──
test('a member of the pair CANNOT read the timeline', async () => {
  // Deliberate: one side could otherwise read the other's private pulses.
  asUser(A);
  assert.equal((await getTimeline()).status, 403);
});

test('an unrelated student cannot read the timeline', async () => {
  asUser('stranger-9');
  assert.equal((await getTimeline()).status, 403);
});

test('the founder can read it', async () => {
  asUser('founder-1');
  assert.equal((await getTimeline()).status, 200);
});

test('the internal key can read it (server-to-server export)', async () => {
  asUser('stranger-9');
  assert.equal((await getTimeline().set(INTERNAL)).status, 200);
});

// ── Consent gate ──
test('an unconsented pair is not tracked', async () => {
  consented = new Set();
  const res = await postEvent(evt());
  assert.equal(res.status, 403);
  assert.equal(res.body.consented, false);
  assert.equal(stored.length, 0, 'and nothing is written');
});

test('consent can be granted then revoked, and revoking stops tracking', async () => {
  consented = new Set();
  assert.equal((await request(app).post(`/pairs/${PAIR}/consent`).send({ scope: 'conflict study' })).status, 200);
  assert.equal((await postEvent(evt())).status, 200);
  await request(app).post(`/pairs/${PAIR}/consent`).send({ revoke: true });
  assert.equal((await postEvent(evt({ id: 'e2' }))).status, 403, 'revoked ⇒ no further tracking');
});

test('a non-member cannot consent on a pair\'s behalf', async () => {
  asUser('stranger-9');
  assert.equal((await request(app).post(`/pairs/${PAIR}/consent`).send({})).status, 403);
});

// ── Ingest ──
test('a pair member can post an event', async () => {
  const res = await postEvent(evt());
  assert.equal(res.status, 200);
  assert.equal(res.body.stored, 1);
  assert.equal(stored.length, 1);
});

test('a non-member cannot post to this pair', async () => {
  asUser('stranger-9');
  assert.equal((await postEvent(evt())).status, 403);
});

test('the internal key can post server-emitted events', async () => {
  asUser('stranger-9');
  const res = await postEvent({ ...evt(), userId: A }, INTERNAL);
  assert.equal(res.status, 200);
  assert.equal(res.body.stored, 1);
});

// ── The counterfactual: arm integrity ──
test('a client CANNOT choose its own arm', async () => {
  await postEvent(evt({ payload: { subtype: 'conflict_flagged', episodeId: 'ep-1', arm: 'intervention' } }));
  const { assignArm } = require('../services/pairEvents');
  // Param 12 is `arm`. It must equal the server's deterministic assignment for
  // ep-1, regardless of what the payload asked for.
  assert.equal(stored[0][11], assignArm('ep-1'), 'arm must be server-resolved, not client-chosen');
});

test('every event in an episode inherits the SAME arm', async () => {
  await postEvent(evt({ id: 'x1', payload: { subtype: 'conflict_flagged', episodeId: 'ep-7' } }));
  await postEvent(evt({ id: 'x2', payload: { kind: 'intervention', subtype: 'nudge_shown', episodeId: 'ep-7' } }));
  await postEvent(evt({ id: 'x3', payload: { kind: 'outcome', subtype: 'checkin', value: 4, episodeId: 'ep-7' } }));
  const arms = stored.map(p => p[11]);
  assert.equal(new Set(arms).size, 1, 'an episode must not change arms mid-flight');
  assert.ok(['intervention', 'control'].includes(arms[0]));
});

test('events with no episode carry a null arm', async () => {
  await postEvent(evt());
  assert.equal(stored[0][10], null, 'episode_id null');
  assert.equal(stored[0][11], null, 'arm null — an ordinary pulse is not in a trial');
});

// ── Timeline shape (what makes the delta computable) ──
test('the timeline exposes episode_id + arm per event, and rolls up episodes', async () => {
  timelineRows = [
    { id: 'a', user_id: A, pair_id: B, pair_key: PAIR, t: '100', kind: 'signal', subtype: 'conflict_flagged', topic: 'dishes', value: null, meta: null, episode_id: 'ep-1', arm: 'intervention', created_at: 'c1' },
    { id: 'b', user_id: A, pair_id: B, pair_key: PAIR, t: '200', kind: 'intervention', subtype: 'repair_completed', topic: 'dishes', value: null, meta: null, episode_id: 'ep-1', arm: 'intervention', created_at: 'c2' },
    { id: 'c', user_id: B, pair_id: A, pair_key: PAIR, t: '300', kind: 'outcome', subtype: 'checkin', topic: null, value: 4, meta: null, episode_id: 'ep-1', arm: 'intervention', created_at: 'c3' },
  ];
  asUser('founder-1');
  const res = await getTimeline();
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 3);
  for (const e of res.body.events) {
    assert.equal(e.episodeId, 'ep-1');
    assert.equal(e.arm, 'intervention');
    assert.equal(typeof e.t, 'number', 'BIGINT must come back as a number for the export');
  }
  assert.equal(res.body.episodes.length, 1);
  assert.equal(res.body.episodes[0].arm, 'intervention');
  assert.equal(res.body.episodes[0].events, 3);
  // signal → intervention → outcome, in order: the chain the analysis needs.
  assert.deepEqual(res.body.events.map(e => e.kind), ['signal', 'intervention', 'outcome']);
});

test('an empty pair returns an honest empty timeline', async () => {
  asUser('founder-1');
  const res = await getTimeline();
  assert.equal(res.body.count, 0);
  assert.deepEqual(res.body.events, []);
  assert.deepEqual(res.body.episodes, []);
});
