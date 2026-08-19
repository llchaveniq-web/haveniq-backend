// POST /matches/connect — target user's ban/pause status must be checked.
//
// Found by audit: refuseBanned (stacked on this route) only stops the
// SENDER if THEY are banned — the target user's is_banned/is_paused was
// never checked at all, even though GET /matches/feed already excludes
// both from the candidate pool. A locally-cached card from before a ban,
// a pause, or a direct API call could still successfully create a pending
// connect_requests row against a banned or paused user. Fixed by pulling
// is_banned/is_paused into the same query that already re-checks
// viability, and returning the same generic 404 the block check uses
// (so this doesn't leak WHY a request can't be sent). node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const VIEWER = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

let targetRow = { id: TARGET, is_banned: false, is_paused: false };
let insertCalls = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT score, is_hard_blocked, breakdown\s+FROM compatibility_scores/.test(sql)) {
      return { rows: [{ score: '80', is_hard_blocked: false, breakdown: {} }] };
    }
    if (/FROM user_blocks/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT id, budget_min, budget_max, move_in_timeline, is_banned, is_paused FROM users/.test(sql)) {
      return { rows: [{ id: VIEWER, is_banned: false, is_paused: false }, targetRow] };
    }
    if (/SELECT id, status, updated_at FROM connect_requests/.test(sql)) {
      return { rows: [] };
    }
    if (/INSERT INTO connect_requests/.test(sql)) {
      insertCalls.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: VIEWER, school: 'Ohio University' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/matches', require('./matches'));

const send = () => request(app).post('/matches/connect').send({ toUserId: TARGET });

test.beforeEach(() => {
  targetRow = { id: TARGET, is_banned: false, is_paused: false };
  insertCalls = [];
});

test('a normal, active target: the request goes through', async () => {
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(insertCalls.length, 1);
});

test('a BANNED target: refused with the same generic 404 blocks use, no row created', async () => {
  targetRow = { id: TARGET, is_banned: true, is_paused: false };
  const res = await send();
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Match not found');
  assert.equal(insertCalls.length, 0);
});

test('a PAUSED target: also refused — they took themselves off the market on purpose', async () => {
  targetRow = { id: TARGET, is_banned: false, is_paused: true };
  const res = await send();
  assert.equal(res.status, 404);
  assert.equal(insertCalls.length, 0);
});

test('a target that is both banned AND paused: still just the generic 404 (no double-signal leak)', async () => {
  targetRow = { id: TARGET, is_banned: true, is_paused: true };
  const res = await send();
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Match not found');
});

test('null is_banned/is_paused (legacy rows with no default backfilled) reads as "not banned, not paused"', async () => {
  targetRow = { id: TARGET, is_banned: null, is_paused: null };
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(insertCalls.length, 1);
});
