// The mutual, verified roommate-vouch flow (docs/BACKEND_ROOMMATE_REPUTATION.md)
// — what makes it unfakeable vs. src/routes/vouches.js's public testimonials:
// (1) gated to an actual 'moved_in_together' self-report on file for the
// pair (match_outcomes) — deliberately stronger than "they matched" or "a
// connect_requests row exists", since either of those is true for pairs who
// never actually lived together; (2) double opt-in — the about_user must
// explicitly confirm before anything counts; (3) visibility defaults
// private and is the about_user's call alone. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const FROM  = '11111111-1111-1111-1111-111111111111';
const ABOUT = '22222222-2222-2222-2222-222222222222';

let everMovedIn = true;
let existingRow    = null; // { id, status } — simulates the idempotency check
let insertedParams  = null;
let pushCalls        = [];
let updateResult      = { rowCount: 1, rows: [{ from_user_id: FROM }] };
let lastUpdateParams  = null;
let currentUserId     = ABOUT; // confirm/decline/visibility are called BY the about_user in real use
let corroborationInsertParams = null; // the confirm-triggered moved_in_together auto-stamp
let corroborationInsertSql    = null;

// The nudge/corroboration inserts are fire-and-forget (not awaited by the
// handler) — give them a tick to land before asserting.
const flush = () => new Promise(r => setImmediate(r));

inject('../db/pool', {
  query: async (sql, params) => {
    // Checked BEFORE the bare "SELECT 1 FROM match_outcomes" branch below —
    // the corroboration INSERT's own WHERE NOT EXISTS subquery contains that
    // exact substring, so the order here matters.
    if (/INSERT INTO match_outcomes/.test(sql)) { corroborationInsertParams = params; corroborationInsertSql = sql; return { rows: [] }; }
    if (/SELECT 1 FROM match_outcomes/.test(sql)) return { rows: everMovedIn ? [{ '?column?': 1 }] : [] };
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
  everMovedIn = true;
  existingRow = null;
  insertedParams = null;
  lastUpdateParams = null;
  pushCalls = [];
  updateResult = { rowCount: 1, rows: [{ from_user_id: FROM }] };
  currentUserId = FROM; // default: the requester's perspective (POST .../request tests)
  contentAction = 'allow';
  corroborationInsertParams = null;
  corroborationInsertSql = null;
});

test('rejects a request when there is no moved_in_together record for the pair — the load-bearing anti-forgery gate', async () => {
  everMovedIn = false;
  const res = await request(app)
    .post(`/roommate-vouches/${ABOUT}/request`)
    .send({ wouldLiveAgain: true });
  assert.equal(res.status, 403);
  assert.equal(insertedParams, null, 'nothing should have been inserted');
});

test('a real MATCH alone is not enough — merely having matched/chatted, with no moved-in report, is still rejected', async () => {
  // This is the specific gap the gate closes: two real, connected accounts
  // who never actually lived together should not be able to fabricate a
  // cohabitation claim just because they matched.
  everMovedIn = false;
  const res = await request(app)
    .post(`/roommate-vouches/${ABOUT}/request`)
    .send({ wouldLiveAgain: true, note: 'we definitely lived together, trust me' });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /moved-in record/);
});

test('a pair with a real moved_in_together report can request, storing wouldLiveAgain as a real boolean', async () => {
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

test('confirming a vouch is itself an attestation — auto-stamps the confirmer\'s OWN moved_in_together report', async () => {
  currentUserId = ABOUT;
  await request(app).post('/roommate-vouches/33333333-3333-3333-3333-333333333333/confirm');
  await flush();
  assert.ok(corroborationInsertParams, 'a match_outcomes row should have been inserted');
  // reporter = the confirmer (about_user), other = the original requester.
  // 'moved_in_together' is inlined as a SQL literal (not a $N param) so it
  // can never drift from any other outcome — checked against the SQL text.
  assert.equal(corroborationInsertParams[0], ABOUT);
  assert.equal(corroborationInsertParams[1], FROM);
  assert.match(corroborationInsertSql, /'moved_in_together'/);
});

test('the auto-stamp insert is conditional (WHERE NOT EXISTS) — never duplicates an existing report', async () => {
  currentUserId = ABOUT;
  await request(app).post('/roommate-vouches/33333333-3333-3333-3333-333333333333/confirm');
  await flush();
  // The guard lives in the SQL itself (idempotent even under a race), not in
  // application code deciding whether to run the query at all.
  assert.match(corroborationInsertSql, /WHERE NOT EXISTS/);
});

test('declining does NOT auto-stamp a moved_in_together report — only a real confirm counts as attestation', async () => {
  currentUserId = ABOUT;
  await request(app).post('/roommate-vouches/33333333-3333-3333-3333-333333333333/decline');
  await flush();
  assert.equal(corroborationInsertParams, null);
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
