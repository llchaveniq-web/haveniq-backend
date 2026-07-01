// HTTP-contract test for GET /ops/data-diff. Auth/founder + DB stubbed via the
// require cache. Verifies the founder gate + the honest empty-state. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let latestRow = null;
inject('../db/pool', {
  query: async (sql) => {
    if (sql.startsWith('SELECT * FROM coverage_snapshots')) return { rows: latestRow ? [latestRow] : [] };
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: req.headers['x-test-uid'] || 'user-1' }; next(); },
});
inject('../utils/founders', {
  isFounder: (id) => id === 'founder-1',
  isFounderEmail: () => false, isFounderUser: (u) => u && u.id === 'founder-1',
  getFounderIds: () => ['founder-1'], getFounderEmails: () => [],
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./ops'));

test.beforeEach(() => { latestRow = null; });

test('GET /ops/data-diff requires a founder', async () => {
  const res = await request(app).get('/ops/data-diff').set('x-test-uid', 'user-1');
  assert.equal(res.status, 403);
});

test('GET /ops/data-diff: no snapshot yet → { report: null } (not a fake diff)', async () => {
  const res = await request(app).get('/ops/data-diff').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.report, null);
});

test('GET /ops/data-diff: surfaces the latest report', async () => {
  latestRow = {
    created_at: 't1', baseline: false, anomaly_count: 1,
    totals: { city: 10, metro: 5, county: 3, notResolved: 2, total: 20 },
    diff: { regressions: [{ domain: 'a.edu', from: 'city', to: '404' }], anomalies: [{ kind: 'regression', domain: 'a.edu', severity: 'high' }] },
  };
  const res = await request(app).get('/ops/data-diff').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.report.anomalyCount, 1);
  assert.equal(res.body.report.totals.city, 10);
  assert.equal(res.body.report.diff.regressions[0].to, '404');
});
