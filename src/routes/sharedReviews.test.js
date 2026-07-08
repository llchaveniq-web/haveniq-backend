'use strict';

// Landlord + building reviews are network-wide public UGC that name a real
// landlord / building — the highest-exposure text in the app. These lock that
// their free text is content-screened (an abusive one is refused) plus core
// validation. HTTP test with pool/auth/content-filter/rate-limit stubbed via
// the require cache. node --test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

inject('../db/pool', {
  query: async () => ({ rows: [{ id: 'rev-1', created_at: '2026-07-07T00:00:00Z' }] }),
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: req.headers['x-test-uid'] || 'me' }; next(); },
});
inject('../middleware/rateLimits', {
  writeReview: (_req, _res, next) => next(),
});
inject('../lib/contentFilter', {
  screenMessage: (text) => ({ action: /BLOCKME/.test(text) ? 'block' : 'allow', category: null, crisis: false }),
});

const express = require('express');
const request = require('supertest');
const { landlordRouter, buildingRouter } = require('./sharedReviews');
const app = express();
app.use(express.json());
app.use('/landlord-reviews', landlordRouter);
app.use('/building-reviews', buildingRouter);

const uid = (r) => r.set('x-test-uid', 'me');
const landlord = { landlordName: 'Acme Property Mgmt', ratingOverall: 2, reviewText: 'Slow to fix a leaking sink, but returned the deposit in full.' };
const building = { buildingAddress: '100 Main St', ratingOverall: 3, pros: 'Quiet street, good light.', cons: 'Radiators clank in winter.' };

test('landlord: a clean review posts', async () => {
  const res = await uid(request(app).post('/landlord-reviews')).send(landlord);
  assert.equal(res.status, 201);
});

test('landlord: an abusive review is blocked', async () => {
  const res = await uid(request(app).post('/landlord-reviews')).send({ ...landlord, reviewText: 'BLOCKME this slumlord is a criminal who should be run out of town.' });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'content_blocked');
});

test('landlord: an abusive landlord NAME is blocked too (it is displayed)', async () => {
  const res = await uid(request(app).post('/landlord-reviews')).send({ ...landlord, landlordName: 'BLOCKME Slur Rentals' });
  assert.equal(res.status, 422);
});

test('landlord: landlordName + a valid rating + 10-char text required', async () => {
  assert.equal((await uid(request(app).post('/landlord-reviews')).send({ ...landlord, landlordName: '' })).status, 400);
  assert.equal((await uid(request(app).post('/landlord-reviews')).send({ ...landlord, ratingOverall: 9 })).status, 400);
  assert.equal((await uid(request(app).post('/landlord-reviews')).send({ ...landlord, reviewText: 'short' })).status, 400);
});

test('building: a clean review posts', async () => {
  const res = await uid(request(app).post('/building-reviews')).send(building);
  assert.equal(res.status, 201);
});

test('building: an abusive pros/cons is blocked', async () => {
  const res = await uid(request(app).post('/building-reviews')).send({ ...building, cons: 'BLOCKME the manager is a disgusting human being and here is why' });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'content_blocked');
});

test('building: buildingAddress + a valid rating required', async () => {
  assert.equal((await uid(request(app).post('/building-reviews')).send({ ...building, buildingAddress: '' })).status, 400);
  assert.equal((await uid(request(app).post('/building-reviews')).send({ ...building, ratingOverall: 0 })).status, 400);
});
