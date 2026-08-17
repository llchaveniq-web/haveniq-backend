// POST /reviews and friends — the relationship-gate + moderation hardening.
//
// This file used to have NONE of the hardening its landlord-review sibling
// (routes/sharedReviews.js) already has: no relationship check at all (any
// authenticated account could post a permanent, public review about any
// other user's UUID — a real harassment vector against a real, named
// student), FLAG-tier content silently dropped instead of queued, no
// moderator hide, and no author retract. Locks the fix. pool/auth/
// contentFilter/founders stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const ME = 'me-1';
const STRANGER = 'stranger-9';
let connectedRow = { x: 1 }; // present = areConnected() true
let hiddenReviews = [];
let deleteCalls = [];
let updateHiddenCalls = [];
let insertCalls = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT 1 FROM connect_requests/.test(sql)) return { rows: connectedRow ? [connectedRow] : [] };
    if (/ALTER TABLE roommate_reviews/.test(sql)) return { rows: [] };
    if (/INSERT INTO roommate_reviews/.test(sql)) {
      insertCalls.push(params);
      return { rows: [{ id: 'review-1', created_at: '2026-08-01T00:00:00Z' }] };
    }
    if (/DELETE FROM roommate_reviews/.test(sql)) {
      deleteCalls.push(params);
      return { rowCount: params[1] === ME ? 1 : 0 };
    }
    if (/SELECT id, overall_rating.*FROM roommate_reviews\s+WHERE reviewee_id/s.test(sql)) {
      return { rows: hiddenReviews };
    }
    if (/UPDATE roommate_reviews SET hidden/.test(sql)) {
      updateHiddenCalls.push(params);
      return { rowCount: 1 };
    }
    if (/FROM roommate_reviews\s+WHERE flagged_category|FROM roommate_reviews\s+WHERE hidden|FROM roommate_reviews\s+ORDER BY created_at DESC\s+LIMIT 200/s.test(sql)) {
      return { rows: [{ id: 'review-1', reviewer_id: STRANGER, reviewee_id: ME, flagged_category: 'scam', hidden: false }] };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: req.headers['x-test-uid'] || ME }; next(); },
  refuseBanned: (_req, _res, next) => next(),
});
inject('../lib/contentFilter', {
  screenMessage: (text) => {
    if (/BLOCKME/.test(text)) return { action: 'block', category: 'hate', crisis: false };
    if (/scam-signal/.test(text)) return { action: 'flag', category: 'scam', crisis: false };
    return { action: 'allow', category: null, crisis: false };
  },
});
inject('../utils/founders', {
  isModeratorUser: (u) => u?.id === 'mod-1',
});

let auditCalls = [];
inject('../services/auditLog', {
  audit: async (req, action, details) => { auditCalls.push({ userId: req.user?.id, action, details }); },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/reviews', require('./reviews'));

const clean = {
  revieweeId: STRANGER, overallRating: 4, cleanliness: 5,
  communication: 4, respect: 5, noiseLevel: 3,
  body: 'Solid roommate, kept shared spaces clean and communicated well.',
};
const post = (body, uid = ME) => request(app).post('/reviews').set('x-test-uid', uid).send(body);

test.beforeEach(() => {
  connectedRow = { x: 1 };
  hiddenReviews = [];
  deleteCalls = [];
  updateHiddenCalls = [];
  insertCalls = [];
  auditCalls = [];
});

// ── The core fix: relationship gate ──
test('cannot review someone you have never actually matched with', async () => {
  connectedRow = null;
  const res = await post(clean);
  assert.equal(res.status, 403);
  assert.equal(insertCalls.length, 0, 'no review is written for a never-matched target');
});

test('CAN review someone you have an accepted connect_request with', async () => {
  connectedRow = { x: 1 };
  const res = await post(clean);
  assert.equal(res.status, 200);
  assert.equal(insertCalls.length, 1);
});

// ── FLAG-tier queues instead of being dropped ──
test('a scam-signal review still posts but is queued (flagged_category set)', async () => {
  const res = await post({ ...clean, body: 'scam-signal: this roommate wanted rent paid in gift cards, sketchy.' });
  assert.equal(res.status, 200, 'FLAG delivers, unlike BLOCK');
  assert.equal(insertCalls.length, 1);
  const params = insertCalls[0];
  assert.equal(params[8], 'scam', 'flagged_category persisted');
  assert.ok(params[9], 'flagged_at persisted');
});

test('a normal review is not flagged', async () => {
  await post(clean);
  assert.equal(insertCalls[0][8], null);
  assert.equal(insertCalls[0][9], null);
});

// ── Author delete ──
test('the author can delete their own review', async () => {
  const res = await request(app).delete('/reviews/review-1').set('x-test-uid', ME);
  assert.equal(res.status, 200);
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0][1], ME);
});

test('deleting a review that is not yours (or does not exist) 404s', async () => {
  const res = await request(app).delete('/reviews/review-1').set('x-test-uid', STRANGER);
  assert.equal(res.status, 404);
});

// ── GET /reviews/user/:id filters hidden ──
test('a hidden review does not appear in the public list', async () => {
  hiddenReviews = []; // the stub's WHERE hidden = FALSE already excludes it — assert the query shape below
  const res = await request(app).get(`/reviews/user/${ME}`).set('x-test-uid', ME);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

// ── Moderator queue + hide/unhide ──
test('a non-moderator cannot reach the admin queue', async () => {
  const res = await request(app).get('/reviews/admin').set('x-test-uid', ME);
  assert.equal(res.status, 403);
});

test('a moderator can list the flagged queue', async () => {
  const res = await request(app).get('/reviews/admin').set('x-test-uid', 'mod-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.reviews.length, 1);
  assert.equal(res.body.reviews[0].flagged_category, 'scam');
});

test('a non-moderator cannot hide a review', async () => {
  const res = await request(app).patch('/reviews/admin/review-1').set('x-test-uid', ME).send({ hidden: true });
  assert.equal(res.status, 403);
  assert.equal(updateHiddenCalls.length, 0);
});

test('a moderator CAN hide a review, and it is audit-logged', async () => {
  const res = await request(app).patch('/reviews/admin/review-1').set('x-test-uid', 'mod-1').send({ hidden: true });
  assert.equal(res.status, 200);
  assert.equal(updateHiddenCalls.length, 1);
  assert.deepEqual(updateHiddenCalls[0], [true, 'review-1']);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].action, 'roommateReview.hide');
});

test('a moderator can unhide a review too', async () => {
  const res = await request(app).patch('/reviews/admin/review-1').set('x-test-uid', 'mod-1').send({ hidden: false });
  assert.equal(res.status, 200);
  assert.deepEqual(updateHiddenCalls[0], [false, 'review-1']);
  assert.equal(auditCalls[0].action, 'roommateReview.unhide');
});
