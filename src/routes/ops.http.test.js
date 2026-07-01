// HTTP-contract test for GET /ops/health-history. Auth/founder gate stubbed via
// the require cache. Verifies the founder gate and the honest empty-state
// (no data → status 'unknown', history []), then a populated state. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: req.headers['x-test-uid'] || 'user-1' }; next(); },
});
inject('../utils/founders', {
  isFounder: (id) => id === 'founder-1',
  isFounderEmail: () => false, isFounderUser: (u) => u && u.id === 'founder-1',
  getFounderIds: () => ['founder-1'], getFounderEmails: () => [],
});

const { watcher } = require('../services/healthWatchRunner');
const { classify } = require('../services/healthWatch');

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./ops'));

test('GET /ops/health-history requires a founder', async () => {
  const res = await request(app).get('/ops/health-history').set('x-test-uid', 'user-1');
  assert.equal(res.status, 403);
});

test('GET /ops/health-history: no data yet → empty history, status unknown (honest)', async () => {
  const res = await request(app).get('/ops/health-history').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.status.state, 'unknown');
  assert.equal(res.body.status.observations, 0);
  assert.equal(res.body.count, 0);
  assert.deepEqual(res.body.history, []);
});

test('GET /ops/health-history: reflects recorded observations, newest first', async () => {
  watcher.observe(classify({ httpStatus: 200, body: { db: 'up', commit: 'abc1234' }, latencyMs: 7 }), 't1');
  watcher.observe(classify({ httpStatus: 503, body: { db: 'down', commit: 'abc1234' }, latencyMs: 9 }), 't2');
  const res = await request(app).get('/ops/health-history').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.history[0].timestamp, 't2');   // newest first
  assert.equal(res.body.history[0].healthy, false);
  assert.equal(res.body.status.observations, 2);
  assert.ok(['healthy', 'degraded', 'unhealthy'].includes(res.body.status.state));
});
