// POST /matches/connect — the decline-cooldown fix.
//
// connect_requests.status went 'pending' -> 'accepted'/'declined' with NO
// path back. The "already exists" check treated ANY existing row (pending,
// accepted, OR declined) as a permanent block, so a single decline — bad
// timing, a misread profile, anything — meant that pair could never connect
// through the app again, ever. Compare: the accept path already revives a
// previously-unmatched conversation; declines never got the same care.
//
// This locks: pending/accepted still block outright (no change there); a
// declined request within CONNECT_DECLINE_COOLDOWN_DAYS still blocks (a "no"
// isn't re-askable the next day); a declined request PAST the cooldown lets
// either side try again, reviving the same row rather than creating a
// second one (the table's UNIQUE(from_user, to_user) assumes exactly one row
// per pair). node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const VIEWER = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';
const DAY_MS = 86400000;

let existingRow = null; // { id, status, updated_at } | null
let updateCalls = [];
let insertCalls = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT score, is_hard_blocked, breakdown\s+FROM compatibility_scores/.test(sql)) {
      return { rows: [{ score: '80', is_hard_blocked: false, breakdown: {} }] };
    }
    if (/FROM user_blocks/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT id, budget_min, budget_max, move_in_timeline FROM users/.test(sql)) {
      return { rows: [{ id: VIEWER }, { id: TARGET }] };
    }
    if (/SELECT id, status, updated_at FROM connect_requests/.test(sql)) {
      return { rows: existingRow ? [existingRow] : [] };
    }
    if (/UPDATE connect_requests\s+SET from_user = \$1, to_user = \$2, status = 'pending'/.test(sql)) {
      updateCalls.push(params);
      return { rows: [] };
    }
    if (/INSERT INTO connect_requests/.test(sql)) {
      insertCalls.push(params);
      return { rows: [] };
    }
    // maybeEmailConnectRequest's lookup, and anything else — empty is safe.
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
  existingRow = null;
  updateCalls = [];
  insertCalls = [];
});

test('no prior request: a fresh row is inserted', async () => {
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(insertCalls.length, 1);
  assert.equal(updateCalls.length, 0);
});

test('a PENDING request still blocks a new send outright', async () => {
  existingRow = { id: 'cr-1', status: 'pending', updated_at: new Date().toISOString() };
  const res = await send();
  assert.equal(res.status, 409);
  assert.equal(insertCalls.length, 0);
  assert.equal(updateCalls.length, 0);
});

test('an ACCEPTED request still blocks a new send outright', async () => {
  existingRow = { id: 'cr-1', status: 'accepted', updated_at: new Date(Date.now() - 365 * DAY_MS).toISOString() };
  const res = await send();
  assert.equal(res.status, 409);
});

test('a DECLINED request within the cooldown window still blocks — a "no" is not re-askable the next day', async () => {
  existingRow = { id: 'cr-1', status: 'declined', updated_at: new Date(Date.now() - 5 * DAY_MS).toISOString() };
  const res = await send();
  assert.equal(res.status, 409);
  assert.equal(res.body.status, 'declined');
  assert.equal(insertCalls.length, 0);
  assert.equal(updateCalls.length, 0);
});

test('a DECLINED request right at the cooldown boundary is not yet retryable', async () => {
  existingRow = { id: 'cr-1', status: 'declined', updated_at: new Date(Date.now() - 29 * DAY_MS).toISOString() };
  const res = await send();
  assert.equal(res.status, 409);
});

test('a DECLINED request PAST the cooldown is revived, not duplicated', async () => {
  existingRow = { id: 'cr-1', status: 'declined', updated_at: new Date(Date.now() - 31 * DAY_MS).toISOString() };
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(insertCalls.length, 0, 'no second row — the table assumes one row per pair');
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0], [VIEWER, TARGET, 'cr-1']);
});

test('the revived row is reachable by either side, not just the original decliner', async () => {
  // TARGET originally declined VIEWER; now VIEWER tries again (this test's
  // default sender). The lookup is bidirectional, so this must still work.
  existingRow = { id: 'cr-1', status: 'declined', updated_at: new Date(Date.now() - 40 * DAY_MS).toISOString() };
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(updateCalls[0][0], VIEWER, 'from_user is updated to the NEW sender');
  assert.equal(updateCalls[0][1], TARGET);
});
