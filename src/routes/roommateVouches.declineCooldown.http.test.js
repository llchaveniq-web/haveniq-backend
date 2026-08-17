// POST /roommate-vouches/:aboutUserId/request — the decline-cooldown fix.
//
// A declined roommate vouch used to be a PERMANENT dead end: the "already
// exists" idempotency check treated ANY existing row (pending, confirmed, OR
// declined) as a silent no-op — { ok: true, status: 'declined' } forever,
// with no path back and the about_user never even seeing a second ask. A
// mis-tap decline or "not now" was indistinguishable from a deliberate
// lifetime block. Compare: connect_requests declines already got this same
// fix (matches.connectCooldown.http.test.js) — vouches never did.
//
// This locks: pending/confirmed rows still block outright (no change there,
// since only a DECLINED row has a cooldown clock at all); a declined row
// within VOUCH_DECLINE_COOLDOWN_DAYS still blocks (a "no" isn't re-askable
// the next day); a declined row PAST the cooldown revives the SAME row
// (UPDATE, not a second INSERT — the unique index assumes one row per pair)
// back to pending with the new attempt's would_live_again/note, clears both
// timestamp columns, and re-notifies the about_user. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const FROM  = '11111111-1111-1111-1111-111111111111';
const ABOUT = '22222222-2222-2222-2222-222222222222';
const DAY_MS = 86400000;

let existingRow = null; // { id, status, declined_at } | null
let insertedParams = null;
let updateCalls = [];
let pushCalls = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT 1 FROM match_outcomes/.test(sql)) return { rows: [{ '?column?': 1 }] }; // always "moved in" for this file
    if (/SELECT id, status, declined_at FROM roommate_vouches WHERE from_user_id/.test(sql)) {
      return { rows: existingRow ? [existingRow] : [] };
    }
    if (/INSERT INTO roommate_vouches/.test(sql)) {
      insertedParams = params;
      return { rows: [{ id: 'new-vouch-id', status: 'pending' }] };
    }
    if (/UPDATE roommate_vouches\s+SET status = 'pending', would_live_again = \$1, note = \$2/.test(sql)) {
      updateCalls.push(params);
      return { rows: [] };
    }
    return { rows: [] }; // ensureTables' CREATE/INDEX
  },
});
inject('../lib/contentFilter', { screenMessage: () => ({ action: 'allow' }) });
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: FROM, first_name: 'Jordan' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.set('sendPushToUser', (userId, payload) => { pushCalls.push({ userId, payload }); return Promise.resolve(); });
app.use('/roommate-vouches', require('./roommateVouches'));

const send = (body = { wouldLiveAgain: true }) =>
  request(app).post(`/roommate-vouches/${ABOUT}/request`).send(body);

test.beforeEach(() => {
  existingRow = null;
  insertedParams = null;
  updateCalls = [];
  pushCalls = [];
});

test('no prior request: a fresh row is inserted', async () => {
  const res = await send();
  assert.equal(res.status, 200);
  assert.ok(insertedParams);
  assert.equal(updateCalls.length, 0);
});

test('a PENDING row still blocks outright — no update, no insert, idempotent response', async () => {
  existingRow = { id: 'cr-1', status: 'pending', declined_at: null };
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.id, 'cr-1');
  assert.equal(insertedParams, null);
  assert.equal(updateCalls.length, 0);
});

test('a CONFIRMED row still blocks outright regardless of age', async () => {
  existingRow = { id: 'cr-1', status: 'confirmed', declined_at: null };
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'confirmed');
  assert.equal(insertedParams, null);
  assert.equal(updateCalls.length, 0);
});

test('a DECLINED row within the cooldown window still blocks — a "no" is not re-askable the next day', async () => {
  existingRow = { id: 'cr-1', status: 'declined', declined_at: new Date(Date.now() - 5 * DAY_MS).toISOString() };
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'declined');
  assert.equal(insertedParams, null);
  assert.equal(updateCalls.length, 0);
  assert.equal(pushCalls.length, 0, 'no re-notify while still cooled down');
});

test('a DECLINED row right at the cooldown boundary is not yet retryable', async () => {
  existingRow = { id: 'cr-1', status: 'declined', declined_at: new Date(Date.now() - 29 * DAY_MS).toISOString() };
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'declined');
  assert.equal(updateCalls.length, 0);
});

test('a DECLINED row PAST the cooldown is revived with the new attempt\'s data, not duplicated', async () => {
  existingRow = { id: 'cr-1', status: 'declined', declined_at: new Date(Date.now() - 31 * DAY_MS).toISOString() };
  const res = await send({ wouldLiveAgain: false, note: 'giving it another shot' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.id, 'cr-1');
  assert.equal(insertedParams, null, 'no second row — the unique index assumes one row per pair');
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0], [false, 'giving it another shot', 'cr-1']);
});

test('reviving a cooled-down decline re-notifies the about_user, same as a fresh request', async () => {
  existingRow = { id: 'cr-1', status: 'declined', declined_at: new Date(Date.now() - 40 * DAY_MS).toISOString() };
  await send();
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].userId, ABOUT);
});

test('a declined row with a null declined_at (pre-migration legacy row) is treated as not cooled down', async () => {
  existingRow = { id: 'cr-1', status: 'declined', declined_at: null };
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'declined');
  assert.equal(updateCalls.length, 0, 'no timestamp to measure cooldown from — stays blocked rather than silently reviving');
});
