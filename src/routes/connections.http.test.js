// /connections — the backend half of stores/socialGraphStore.ts. Was
// local-only on one device (SecureStore + a one-way analytics event); this
// makes it a real, two-sided request/accept/decline flow. pool/auth stubbed,
// no live Postgres. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let listRows = [];
let existingRow = null;   // what the "check existing pair" SELECT returns
let insertReturns = { id: 'conn-new' };
let updateReturns = [];   // what accept/decline UPDATE ... RETURNING returns
let deleteReturns = [];
let throwOnQuery = false;
let queries = [];         // every (sql, params) pair, for shape assertions

inject('../db/pool', {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (throwOnQuery) throw new Error('db exploded');
    if (/CREATE TABLE|CREATE (UNIQUE )?INDEX/.test(sql)) return { rows: [] };
    if (/SELECT c\.id, c\.status, c\.requester_id, c\.target_id/.test(sql)) return { rows: listRows };
    if (/SELECT id, status, requester_id FROM connections/.test(sql)) {
      return { rows: existingRow ? [existingRow] : [] };
    }
    if (/INSERT INTO connections/.test(sql)) return { rows: [insertReturns] };
    if (/UPDATE connections/.test(sql)) return { rows: updateReturns };
    if (/DELETE FROM connections/.test(sql)) return { rows: deleteReturns };
    return { rows: [] };
  },
});

let pushCalls = [];
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'me-1', first_name: 'Jo' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.set('sendPushToUser', (userId, payload) => {
  pushCalls.push({ userId, payload });
  return Promise.resolve();
});
app.use('/connections', require('./connections'));

test.beforeEach(() => {
  listRows = []; existingRow = null; insertReturns = { id: 'conn-new' };
  updateReturns = []; deleteReturns = []; throwOnQuery = false; queries = []; pushCalls = [];
});

// ── GET / ────────────────────────────────────────────────────────────────

test('GET / — empty list is ok:true, not an error', async () => {
  const res = await request(app).get('/connections');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, connections: [] });
});

test('GET / — I am the requester on a pending row -> pending_outbound', async () => {
  listRows = [{
    id: 'c1', status: 'pending', requester_id: 'me-1', target_id: 'them-1',
    created_at: '2026-01-01', confirmed_at: null,
    other_id: 'them-1', first_name: 'Sam', last_name: 'T.', photo_url: null,
    school_year: 'Junior', quiz_completed: false, score: null,
  }];
  const res = await request(app).get('/connections');
  assert.equal(res.body.connections[0].status, 'pending_outbound');
});

test('GET / — I am the target on a pending row -> pending_inbound', async () => {
  listRows = [{
    id: 'c2', status: 'pending', requester_id: 'them-2', target_id: 'me-1',
    created_at: '2026-01-01', confirmed_at: null,
    other_id: 'them-2', first_name: 'Ari', last_name: 'P.', photo_url: null,
    school_year: null, quiz_completed: false, score: null,
  }];
  const res = await request(app).get('/connections');
  assert.equal(res.body.connections[0].status, 'pending_inbound');
  assert.equal(res.body.connections[0].userId, 'them-2');
});

test('GET / — confirmed and declined pass through as-is, and score computes when the quiz is done', async () => {
  listRows = [
    {
      id: 'c3', status: 'confirmed', requester_id: 'me-1', target_id: 'them-3',
      created_at: '2026-01-01', confirmed_at: '2026-01-02',
      other_id: 'them-3', first_name: 'Lee', last_name: null, photo_url: null,
      school_year: null, quiz_completed: true, score: '91.20',
    },
    {
      id: 'c4', status: 'declined', requester_id: 'them-4', target_id: 'me-1',
      created_at: '2026-01-01', confirmed_at: null,
      other_id: 'them-4', first_name: 'Kai', last_name: 'M.', photo_url: null,
      school_year: null, quiz_completed: false, score: null,
    },
  ];
  const res = await request(app).get('/connections');
  assert.equal(res.body.connections[0].status, 'confirmed');
  assert.deepEqual(res.body.connections[0].score, { finalPct: 91, tier: 'exceptional' });
  assert.equal(res.body.connections[1].status, 'declined');
  assert.equal(res.body.connections[1].score, null);
});

test('GET / — a DB failure fails closed: ok:false, empty list, never a blank crash', async () => {
  throwOnQuery = true;
  const res = await request(app).get('/connections');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { ok: false, connections: [] });
});

// ── POST /request ───────────────────────────────────────────────────────

test('POST /request — missing targetUserId is 400', async () => {
  const res = await request(app).post('/connections/request').send({});
  assert.equal(res.status, 400);
});

test('POST /request — cannot request yourself', async () => {
  const res = await request(app).post('/connections/request').send({ targetUserId: 'me-1' });
  assert.equal(res.status, 400);
});

test('POST /request — a fresh pair creates a pending row and pushes the target', async () => {
  const res = await request(app).post('/connections/request').send({ targetUserId: 'them-5' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, id: 'conn-new', status: 'pending_outbound' });
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].userId, 'them-5');
});

test('POST /request — an existing pending row is returned idempotently, no duplicate insert, no push', async () => {
  existingRow = { id: 'c9', status: 'pending', requester_id: 'me-1' };
  const res = await request(app).post('/connections/request').send({ targetUserId: 'them-6' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, id: 'c9', status: 'pending_outbound' });
  assert.equal(pushCalls.length, 0);
  assert.ok(!queries.some(q => /INSERT INTO connections/.test(q.sql)), 'must not insert a duplicate row');
});

test('POST /request — an existing pending row initiated by THEM shows as pending_inbound to me', async () => {
  existingRow = { id: 'c10', status: 'pending', requester_id: 'them-7' };
  const res = await request(app).post('/connections/request').send({ targetUserId: 'them-7' });
  assert.equal(res.body.status, 'pending_inbound');
});

test('POST /request — an existing confirmed row is returned as-is, not reset to pending', async () => {
  existingRow = { id: 'c11', status: 'confirmed', requester_id: 'them-8' };
  const res = await request(app).post('/connections/request').send({ targetUserId: 'them-8' });
  assert.deepEqual(res.body, { ok: true, id: 'c11', status: 'confirmed' });
});

// ── POST /:id/accept ─────────────────────────────────────────────────────

test('POST /:id/accept — succeeds, confirms, and pushes the ORIGINAL requester (not me)', async () => {
  updateReturns = [{ id: 'c1', requester_id: 'them-9' }];
  const res = await request(app).post('/connections/c1/accept');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, status: 'confirmed' });
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].userId, 'them-9');
});

test('POST /:id/accept — the query is scoped to target_id = me AND status = pending (can\'t self-accept or re-accept)', async () => {
  updateReturns = [{ id: 'c1', requester_id: 'them-9' }];
  await request(app).post('/connections/c1/accept');
  const upd = queries.find(q => /UPDATE connections/.test(q.sql));
  assert.match(upd.sql, /target_id = \$2/);
  assert.match(upd.sql, /status = 'pending'/);
  assert.deepEqual(upd.params, ['c1', 'me-1']);
});

test('POST /:id/accept — no matching pending row (wrong user, or already resolved) is 404, no push', async () => {
  updateReturns = [];
  const res = await request(app).post('/connections/c1/accept');
  assert.equal(res.status, 404);
  assert.equal(pushCalls.length, 0);
});

// ── POST /:id/decline ────────────────────────────────────────────────────

test('POST /:id/decline — succeeds, declines, and sends NO push (unlike accept)', async () => {
  updateReturns = [{ id: 'c1' }];
  const res = await request(app).post('/connections/c1/decline');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, status: 'declined' });
  assert.equal(pushCalls.length, 0);
});

test('POST /:id/decline — also scoped to target_id = me AND status = pending', async () => {
  updateReturns = [{ id: 'c1' }];
  await request(app).post('/connections/c1/decline');
  const upd = queries.find(q => /UPDATE connections/.test(q.sql));
  assert.match(upd.sql, /target_id = \$2/);
  assert.deepEqual(upd.params, ['c1', 'me-1']);
});

test('POST /:id/decline — no matching pending row is 404', async () => {
  updateReturns = [];
  const res = await request(app).post('/connections/c1/decline');
  assert.equal(res.status, 404);
});

// ── DELETE /:id ──────────────────────────────────────────────────────────

test('DELETE /:id — either side can remove; the query allows requester_id OR target_id = me', async () => {
  deleteReturns = [{ id: 'c1' }];
  const res = await request(app).delete('/connections/c1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  const del = queries.find(q => /DELETE FROM connections/.test(q.sql));
  assert.match(del.sql, /requester_id = \$2 OR target_id = \$2/);
});

test('DELETE /:id — a third party (neither side) gets 404, nothing removed', async () => {
  deleteReturns = [];
  const res = await request(app).delete('/connections/c1');
  assert.equal(res.status, 404);
});
