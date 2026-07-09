'use strict';

// Reviews are the most sensitive UGC in the app — public, and about a NAMED
// person. These lock that a review is screened like every other UGC surface
// (an abusive one is refused) plus the core validation. HTTP test with
// pool/auth/content-filter stubbed via the require cache. node --test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

inject('../db/pool', {
  query: async () => ({ rows: [{ id: 'review-1', created_at: '2026-07-07T00:00:00Z' }] }),
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: req.headers['x-test-uid'] || 'me' }; next(); },
  refuseBanned: (req, res, next) => (req.user?.is_banned ? res.status(403).json({ banned: true }) : next()),
});
inject('../lib/contentFilter', {
  // 'block' when the body carries the abuse marker, else allow.
  screenMessage: (text) => ({ action: /BLOCKME/.test(text) ? 'block' : 'allow', category: null, crisis: false }),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/reviews', require('./reviews'));

const clean = {
  revieweeId: 'them', overallRating: 4, cleanliness: 5,
  communication: 4, respect: 5, noiseLevel: 3,
  body: 'Solid roommate, kept shared spaces clean and communicated well.',
};
const post = (body) => request(app).post('/reviews').set('x-test-uid', 'me').send(body);

test('a clean review posts', async () => {
  const res = await post(clean);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'review-1');
});

test('an abusive review is blocked (content screened like all UGC)', async () => {
  const res = await post({ ...clean, body: 'BLOCKME this person is a slur-worthy nightmare to live with.' });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'content_blocked');
});

test('cannot review yourself', async () => {
  const res = await post({ ...clean, revieweeId: 'me' });
  assert.equal(res.status, 400);
});

test('ratings must be 1-5 integers', async () => {
  const res = await post({ ...clean, overallRating: 6 });
  assert.equal(res.status, 400);
});

test('body must be at least 20 characters', async () => {
  const res = await post({ ...clean, body: 'too short' });
  assert.equal(res.status, 400);
});
