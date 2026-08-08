// The mutual, verified roommate-vouch flow (docs/BACKEND_ROOMMATE_REPUTATION.md)
// — what makes it unfakeable vs. src/routes/vouches.js's public testimonials:
// (1) gated to real HavenIQ match history (connect_requests), (2) double
// opt-in — the about_user must explicitly confirm before anything counts,
// (3) visibility defaults private and is the about_user's call alone.
// node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const FROM  = '11111111-1111-1111-1111-111111111111';
const ABOUT = '22222222-2222-2222-2222-222222222222';

let wereConnected = true;
let existingRow    = null; // { id, status } — simulates the idempotency check
let insertedParams  = null;
let pushCalls        = [];
let updateResult      = { rowCount: 1, rows: [{ from_user_id: FROM }] };
let lastUpdateParams  = null;
let currentUserId     = ABOUT; // confirm/decline/visibility are called BY the about_user in real use

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT 1 FROM connect_requests/.test(sql)) return { rows: wereConnected ? [{ '?column?': 1 }] : [] };
    if (/SELECT id, status FROM roommate_vouches WHERE from_user_id/.test(sql)) {
      return { rows: existingRow ? [existingRow] : [] };
    }
    if (/INSERT INTO roommate_vouches/.test(sql)) {
      insertedParams = params;
      return { rows: [{ id: 'new-vouch-id', status: 'pending' }] };
    }
    if (/UPDATE roommate_vouches SET status/.test(sql)) { lastUpdateParams = params; return updateResult; }
    if (/UPDATE roommate_vouches SET visibility/.test(sql)) { lastUpdateParams = params; return updateResult; }
    return { rows: [] }; // ensureTables' CREATE/INDEX
  },
});
let contentAction = 'allow';
inject('../lib/contentFilter', { screenMessage: () => ({ action: contentAction }) });
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: currentUserId, first_name: 'Jordan' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.set('sendPushToUser', (userId, payload) => { pushCalls.push({ userId, payload }); return Promise.resolve(); });
app.use('/roommate-vouches', require('./roommateVouches'));

test.beforeEach(() => {
  wereConnected = true;
  existingRow = null;
  insertedParams = null;
  lastUpdateParams = null;
  pushCalls = [];
  updateResult = { rowCount: 1, rows: [{ from_user_id: FROM }] };
  currentUserId = FROM; // default: the requester's perspective (POST .../request tests)
  contentAction = 'allow';
});

test('rejects a request between two users who never matched — the load-bearing anti-forgery gate', async () => {
  wereConnected = false;
  const res = await request(app)
    .post(`/roommate-vouches/${ABOUT}/request`)
    .send({ wouldLiveAgain: true });
  assert.equal(res.status, 403);
  assert.equal(insertedParams, null, 'nothing should have been inserted');
});

test('a real past match can request, storing wouldLiveAgain as a real boolean', async () => {
  const res = await request(app)
    .post(`/roommate-vouches/${ABOUT}/request`)
    .send({ wouldLiveAgain: true, note: 'Great to live with.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(insertedParams[2], true);
  assert.equal(insertedParams[3], 'Great to live with.');
});

test('wouldLiveAgain is required — missing/non-boolean is rejected, never defaulted', async () => {
  const res = await request(app).post(`/roommate-vouches/${ABOUT}/request`).send({});
  assert.equal(res.status, 400);
  assert.equal(insertedParams, null);
});

test('cannot vouch for yourself', async () => {
  const res = await request(app)
    .post(`/roommate-vouches/${FROM}/request`)
    .send({ wouldLiveAgain: true });
  assert.equal(res.status, 400);
});

test('a request for an already-existing pair is idempotent, not duplicated', async () => {
  existingRow = { id: 'already-there', status: 'confirmed' };
  const res = await request(app)
    .post(`/roommate-vouches/${ABOUT}/request`)
    .send({ wouldLiveAgain: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'already-there');
  assert.equal(res.body.status, 'confirmed');
  assert.equal(insertedParams, null, 'no duplicate insert');
});

test('a successful request pushes the about_user, not the requester', async () => {
  await request(app).post(`/roommate-vouches/${ABOUT}/request`).send({ wouldLiveAgain: true });
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].userId, ABOUT);
});

test('a blocked-content note is refused before any insert', async () => {
  contentAction = 'block';
  const res = await request(app)
    .post(`/roommate-vouches/${ABOUT}/request`)
    .send({ wouldLiveAgain: true, note: 'something bad' });
  assert.equal(res.status, 422);
  assert.equal(insertedParams, null);
});

test('POST /:id/confirm is scoped to the caller as about_user_id — the authorization lives in the WHERE clause', async () => {
  currentUserId = ABOUT;
  const res = await request(app).post('/roommate-vouches/33333333-3333-3333-3333-333333333333/confirm');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'confirmed');
  // params: [status, id, callerId] — the caller, never a body-supplied id, is what scopes the row.
  assert.equal(lastUpdateParams[2], ABOUT);
});

test('a confirm that matches nothing (wrong user / already resolved) 404s — never a silent success', async () => {
  currentUserId = ABOUT;
  updateResult = { rowCount: 0, rows: [] };
  const res = await request(app).post('/roommate-vouches/33333333-3333-3333-3333-333333333333/confirm');
  assert.equal(res.status, 404);
});

test('confirming pushes the ORIGINAL requester, not the confirmer', async () => {
  currentUserId = ABOUT;
  await request(app).post('/roommate-vouches/33333333-3333-3333-3333-333333333333/confirm');
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].userId, FROM, 'from_user_id returned by the UPDATE');
});

test('declining is scoped the same way as confirm, and sends no push at all', async () => {
  currentUserId = ABOUT;
  const res = await request(app).post('/roommate-vouches/33333333-3333-3333-3333-333333333333/decline');
  assert.equal(res.status, 200);
  assert.equal(lastUpdateParams[2], ABOUT);
  assert.equal(pushCalls.length, 0);
});

test('PATCH visibility rejects anything other than public/private', async () => {
  currentUserId = ABOUT;
  const res = await request(app).patch('/roommate-vouches/33333333-3333-3333-3333-333333333333/visibility').send({ visibility: 'everyone' });
  assert.equal(res.status, 400);
});

test('PATCH visibility is scoped to the caller as about_user_id, and to confirmed rows only', async () => {
  currentUserId = ABOUT;
  const res = await request(app).patch('/roommate-vouches/33333333-3333-3333-3333-333333333333/visibility').send({ visibility: 'public' });
  assert.equal(res.status, 200);
  assert.equal(res.body.visibility, 'public');
  assert.equal(lastUpdateParams[2], ABOUT);
});
