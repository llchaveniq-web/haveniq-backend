// Landlord + building reviews — the moderation-completeness fix.
//
// Content BLOCK-tier screening already existed (see sharedReviews.test.js).
// What was missing: per-(reviewer, subject) dedup (one account could post
// the same review dozens of times), a FLAG tier for scam-signal content
// (previously ignored entirely — only 'block' was checked), an edit/delete
// path for the author, and a moderator review/hide surface (`hidden`
// existed and was filtered on read, but nothing ever set it). This locks
// all of that, for BOTH routers (they're structurally identical). pool/
// auth/contentFilter/rate-limit stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let dupeExists = false;
let inserts = [];
let updateCalls = [];
let deleteCalls = [];
let hideCalls = [];
let adminRows = [];
let ownedReview = { landlord_name: 'Acme Property Mgmt' };

inject('../db/pool', {
  query: async (sql, params) => {
    if (/ALTER TABLE/.test(sql)) return { rows: [] };
    if (/SELECT id FROM \w+_reviews_shared\s+WHERE reviewer_id/.test(sql)) {
      return { rows: dupeExists ? [{ id: 'existing-review' }] : [] };
    }
    if (/SELECT landlord_name FROM landlord_reviews_shared WHERE id = \$1 AND reviewer_id = \$2/.test(sql)) {
      return { rows: ownedReview ? [ownedReview] : [] };
    }
    if (/SELECT id FROM building_reviews_shared WHERE id = \$1 AND reviewer_id = \$2/.test(sql)) {
      return { rows: ownedReview ? [{ id: 'r1' }] : [] };
    }
    if (/INSERT INTO \w+_reviews_shared/.test(sql)) {
      inserts.push(params);
      return { rows: [{ id: 'rev-1', landlord_name: params[1], created_at: '2026-08-16T00:00:00Z' }] };
    }
    if (/UPDATE \w+_reviews_shared\s+SET hidden/.test(sql)) {
      hideCalls.push(params);
      return { rowCount: params[1] === 'missing' ? 0 : 1 };
    }
    if (/UPDATE \w+_reviews_shared/.test(sql)) {
      updateCalls.push(params);
      return { rows: [{ id: 'rev-1', created_at: '2026-08-16T00:00:00Z' }], rowCount: 1 };
    }
    if (/DELETE FROM \w+_reviews_shared/.test(sql)) {
      deleteCalls.push(params);
      return { rowCount: params[0] === 'someone-elses' ? 0 : 1 };
    }
    if (/FROM \w+_reviews_shared r[\s\S]*flagged_category/.test(sql)) return { rows: adminRows };
    return { rows: [] };
  },
});

const { screenMessage } = require('../lib/contentFilter');
inject('../lib/contentFilter', { screenMessage });

let currentUser = { id: 'u1', is_banned: false };
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = currentUser; next(); },
  refuseBanned: (req, res, next) => (req.user?.is_banned ? res.status(403).json({ banned: true }) : next()),
});
inject('../middleware/rateLimits', { writeReview: (_req, _res, next) => next() });
inject('../utils/founders', { isModeratorUser: (u) => u?.id === 'mod-1' });
inject('../services/auditLog', { audit: async () => {} });

const express = require('express');
const request = require('supertest');
const { landlordRouter, buildingRouter } = require('./sharedReviews');
const app = express();
app.use(express.json());
app.use('/landlord-reviews', landlordRouter);
app.use('/building-reviews', buildingRouter);

const asUser = (id, extra = {}) => { currentUser = { id, is_banned: false, ...extra }; };
const landlord = { landlordName: 'Acme Property Mgmt', ratingOverall: 2, reviewText: 'Slow to fix a leaking sink, but returned the deposit in full.' };
const building = { buildingAddress: '100 Main St', ratingOverall: 3, pros: 'Quiet street, good light.' };

test.beforeEach(() => {
  dupeExists = false; inserts = []; updateCalls = []; deleteCalls = []; hideCalls = []; adminRows = [];
  ownedReview = { landlord_name: 'Acme Property Mgmt' };
  asUser('u1');
});

// ── Dedup ──
test('landlord: a second review of the SAME landlord by the same reviewer is refused (409), points to editing instead', async () => {
  dupeExists = true;
  const res = await request(app).post('/landlord-reviews').send(landlord);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'duplicate_review');
  assert.equal(inserts.length, 0);
});

test('building: same dedup behavior', async () => {
  dupeExists = true;
  const res = await request(app).post('/building-reviews').send(building);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'duplicate_review');
});

// ── FLAG tier (previously ignored entirely) ──
test('landlord: a scam-signal review still posts, but is queued (flagged_category set)', async () => {
  const res = await request(app).post('/landlord-reviews')
    .send({ ...landlord, reviewText: 'Wanted the deposit wired via bitcoin before I could even tour the unit.' });
  assert.equal(res.status, 201);
  assert.equal(inserts[0][8], 'scam');
  assert.ok(inserts[0][9]);
});

// ── Author edit ──
test('landlord: the author can edit their own review, re-screened', async () => {
  const res = await request(app).patch('/landlord-reviews/rev-1')
    .send({ ratingOverall: 4, ratingResponse: null, ratingMaintenance: null, ratingFairness: null, reviewText: 'Actually they came back and fixed it properly.' });
  assert.equal(res.status, 200);
  assert.equal(updateCalls.length, 1);
});

test('landlord: editing a review you do not own 404s (ownership enforced in the WHERE clause)', async () => {
  ownedReview = null;
  const res = await request(app).patch('/landlord-reviews/not-mine')
    .send({ ratingOverall: 4, reviewText: 'trying to edit someone else review here ok' });
  assert.equal(res.status, 404);
  assert.equal(updateCalls.length, 0);
});

test('landlord: an edit that introduces blocked content is refused, not silently saved', async () => {
  const res = await request(app).patch('/landlord-reviews/rev-1')
    .send({ ratingOverall: 1, reviewText: 'i will find you and hurt you if you post about me again' });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'content_blocked');
  assert.equal(updateCalls.length, 0);
});

test('building: the author can edit their own review', async () => {
  const res = await request(app).patch('/building-reviews/rev-1')
    .send({ ratingOverall: 5, pros: 'even better than I first thought' });
  assert.equal(res.status, 200);
});

test('a banned user cannot edit a review at all', async () => {
  asUser('u1', { is_banned: true });
  const res = await request(app).patch('/landlord-reviews/rev-1').send({ ratingOverall: 4, reviewText: 'trying to sneak an edit in here' });
  assert.equal(res.status, 403);
  assert.equal(updateCalls.length, 0);
});

// ── Author delete ──
test('landlord: the author can delete their own review', async () => {
  const res = await request(app).delete('/landlord-reviews/rev-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('landlord: deleting someone else\'s review 404s, never a silent success', async () => {
  const res = await request(app).delete('/landlord-reviews/someone-elses');
  assert.equal(res.status, 404);
});

test('building: the author can delete their own review', async () => {
  const res = await request(app).delete('/building-reviews/rev-1');
  assert.equal(res.status, 200);
});

test('a banned user cannot delete a review', async () => {
  asUser('u1', { is_banned: true });
  const res = await request(app).delete('/landlord-reviews/rev-1');
  assert.equal(res.status, 403);
  assert.equal(deleteCalls.length, 0);
});

// ── Moderator review/hide surface ──
test('a non-moderator cannot read the landlord admin queue', async () => {
  asUser('random-student');
  const res = await request(app).get('/landlord-reviews/admin');
  assert.equal(res.status, 403);
});

test('a moderator gets the flagged queue', async () => {
  asUser('mod-1');
  adminRows = [{ id: 'rev-2', flagged_category: 'scam' }];
  const res = await request(app).get('/landlord-reviews/admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.reviews.length, 1);
});

test('a moderator can hide a landlord review — the hidden column finally does something', async () => {
  asUser('mod-1');
  const res = await request(app).patch('/landlord-reviews/admin/rev-1').send({ hidden: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.hidden, true);
  assert.deepEqual(hideCalls[0], [true, 'rev-1']);
});

test('a moderator can hide a building review too', async () => {
  asUser('mod-1');
  const res = await request(app).patch('/building-reviews/admin/rev-1').send({ hidden: true });
  assert.equal(res.status, 200);
});

test('a non-moderator cannot hide a review', async () => {
  asUser('random-student');
  const res = await request(app).patch('/landlord-reviews/admin/rev-1').send({ hidden: true });
  assert.equal(res.status, 403);
  assert.equal(hideCalls.length, 0);
});

test('hiding a review that does not exist 404s', async () => {
  asUser('mod-1');
  const res = await request(app).patch('/landlord-reviews/admin/missing').send({ hidden: true });
  assert.equal(res.status, 404);
});
