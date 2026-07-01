// HTTP-contract test for GET /ops/lifecycle-log. Auth/founder gate + DB stubbed
// via the require cache. Verifies the founder gate and the honest empty-state.
// node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let runsRows = [];
let sendsRows = [];
inject('../db/pool', {
  query: async (sql) => {
    if (sql.includes('FROM lifecycle_runs')) return { rows: runsRows };
    if (sql.includes('FROM lifecycle_sends')) return { rows: sendsRows };
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

test.beforeEach(() => { runsRows = []; sendsRows = []; });

test('GET /ops/lifecycle-log requires a founder', async () => {
  const res = await request(app).get('/ops/lifecycle-log').set('x-test-uid', 'user-1');
  assert.equal(res.status, 403);
});

test('GET /ops/lifecycle-log: nothing sent yet → empty, honest', async () => {
  const res = await request(app).get('/ops/lifecycle-log').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.sendCount, 0);
  assert.deepEqual(res.body.sends, []);
  assert.deepEqual(res.body.runs, []);
  assert.equal(typeof res.body.config.enabled, 'boolean'); // thresholds surfaced for transparency
});

test('GET /ops/lifecycle-log: surfaces recorded runs + sends', async () => {
  runsRows = [{ enabled: true, active_count: 100, threshold: 10, planned: 3, sent: 3, failed: 0, paused: false, by_segment: { quiz_incomplete: 3 }, created_at: 't1' }];
  sendsRows = [{ user_id: 'u1', email: 'a@x.edu', segment: 'quiz_incomplete', template_id: 'quiz_incomplete_v1', status: 'sent', sent_at: 't1' }];
  const res = await request(app).get('/ops/lifecycle-log').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.runs.length, 1);
  assert.equal(res.body.runs[0].sent, 3);
  assert.equal(res.body.sendCount, 1);
  assert.equal(res.body.sends[0].template_id, 'quiz_incomplete_v1');
});
