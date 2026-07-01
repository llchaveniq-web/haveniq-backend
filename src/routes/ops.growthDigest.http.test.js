// HTTP-contract test for GET /ops/growth-digest. Auth/founder + DB stubbed via
// the require cache. Founder gate + honest empty-state. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let latestRow = null;
inject('../db/pool', {
  query: async (sql) => {
    if (sql.includes('FROM growth_digests')) return { rows: latestRow ? [latestRow] : [] };
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

test('GET /ops/growth-digest requires a founder', async () => {
  const res = await request(app).get('/ops/growth-digest').set('x-test-uid', 'user-1');
  assert.equal(res.status, 403);
});

test('GET /ops/growth-digest: no digest yet → { digest: null } (honest empty)', async () => {
  const res = await request(app).get('/ops/growth-digest').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.digest, null);
  assert.equal(typeof res.body.enabled, 'boolean');
});

test('GET /ops/growth-digest: surfaces the latest digest', async () => {
  latestRow = {
    metrics: { funnel: [{ stage: 'signup', count: 50 }], biggestDrop: { from: 'quiz', to: 'match', dropPct: 40 } },
    narrative: 'Signups up this week.', source: 'template', emailed_to: 'f@x.org', created_at: 't1',
  };
  const res = await request(app).get('/ops/growth-digest').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.digest.narrative, 'Signups up this week.');
  assert.equal(res.body.digest.metrics.biggestDrop.dropPct, 40);
});
