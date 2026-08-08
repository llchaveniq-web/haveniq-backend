// GET /admin/friction-validation — Outcome-Learning Loop C (founder-only).
//
// Load-bearing: the route BOOTS (proving requireAdmin→requireFounder was the
// right fix — an undefined handler would throw at app.use time); a non-founder
// is refused; a founder gets honest empty aggregates when no rows carry the
// friction keys; and a cohort below MIN_COHORT_SAMPLE publishes no rate.
// DB + founder gate stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// Founder flag driven per-test via a mutable holder.
let isFounder = true;
inject('../middleware/requireFounder', {
  requireFounder: (req, res, next) =>
    isFounder ? next() : res.status(403).json({ ok: false, error: 'Founder only' }),
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'founder-1' }; next(); },
});

// Mutable rows the stubbed pool returns for the GROUP BY query.
let categoryRows = [];
let detectorRows = [];
inject('../db/pool', {
  query: async (sql) => {
    if (/predictedFrictionCategory/.test(sql)) return { rows: categoryRows };
    if (/predictedFrictionId/.test(sql)) return { rows: detectorRows };
    return { rows: [] };
  },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
// No prefix — the route declares its own full path. If requireFounder/requireAuth
// resolved to undefined, THIS line would throw. Reaching the assertions is proof.
app.use(require('./frictionValidation'));

const get = () => request(app).get('/admin/friction-validation');

test.beforeEach(() => { isFounder = true; categoryRows = []; detectorRows = []; });

test('the route mounts without throwing (no requireAdmin crash)', () => {
  // Reaching here means app.use(...) above did not throw on an undefined handler.
  assert.ok(true);
});

test('non-founder is refused (403)', async () => {
  isFounder = false;
  const res = await get();
  assert.equal(res.status, 403);
});

test('founder, no friction rows: honest empty aggregates (inert state)', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.byCategory, []);
  assert.deepEqual(res.body.byDetector, []);
});

test('a thin cohort (< MIN_COHORT_SAMPLE) publishes NO rate', async () => {
  categoryRows = [{
    key: 'cleanliness', n: '12', confirmed_n: '9', confirmed_reported_n: '12',
    clashed_n: '3', stress_reported_n: '8', dissolved_n: '1', avg_rating: '4.2',
  }];
  const res = await get();
  const row = res.body.byCategory[0];
  assert.equal(row.sampleSize, 12);
  assert.equal(row.publishable, false);
  assert.equal(row.confirmedRate, null, 'unearned rate on a thin sample is withheld');
  assert.equal(row.dissolvedRate, null);
  assert.equal(row.avgRating, null);
});

test('a cohort past the floor publishes the primary confirmedRate', async () => {
  categoryRows = [{
    key: 'sleep', n: '40', confirmed_n: '30', confirmed_reported_n: '40',
    clashed_n: '10', stress_reported_n: '40', dissolved_n: '8', avg_rating: '3.5',
  }];
  const res = await get();
  const row = res.body.byCategory[0];
  assert.equal(row.publishable, true);
  assert.equal(row.confirmedRate, 0.75, '30/40 confirmed');
  assert.equal(row.dissolvedRate, 0.2, '8/40 dissolved');
  assert.equal(row.avgRating, 3.5);
});

test('confirmedRate is gated on its OWN reported count, not n', async () => {
  // Big cohort, but few actually answered the frictionConfirmed question — the
  // primary rate must stay null rather than dilute against n.
  categoryRows = [{
    key: 'guests', n: '50', confirmed_n: '5', confirmed_reported_n: '6',
    clashed_n: '0', stress_reported_n: '0', dissolved_n: '2', avg_rating: null,
  }];
  const res = await get();
  const row = res.body.byCategory[0];
  assert.equal(row.publishable, true, 'cohort itself clears the floor');
  assert.equal(row.confirmedRate, null, 'but only 6 answered the question → no primary rate yet');
  assert.equal(row.dissolvedRate, 0.04, 'secondary proxy still computes');
});
