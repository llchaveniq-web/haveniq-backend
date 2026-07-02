// HTTP-contract test for POST /ops/lifecycle/run (founder manual trigger).
// Proves: (1) the founder gate is enforced; (2) the route calls the REAL
// lifecycleSender.runLifecycle job (not a stub) — observed via the kill-switch
// short-circuit and the real job's DB side effects (segment queries + the
// lifecycle_runs log INSERT) — and returns an honest per-segment/sent/paused
// summary. Auth/founders/pool stubbed via the require cache; no network. With an
// empty pool no users match, so nothing is sent — the correct honest result.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let sqlLog = [];
inject('../db/pool', {
  query: async (sql) => { sqlLog.push(sql); return { rows: [] }; }, // empty → 0 recipients, activeCount 0
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

test.beforeEach(() => { sqlLog = []; });

test('POST /ops/lifecycle/run requires a founder', async () => {
  process.env.WATCH_LIFECYCLE_ENABLED = 'true';
  const res = await request(app).post('/ops/lifecycle/run').set('x-test-uid', 'user-1');
  assert.equal(res.status, 403);
  assert.equal(sqlLog.length, 0, 'non-founder never reaches the job');
});

test('kill switch OFF → { ok:false, reason:disabled }, and the REAL job did NOT run', async () => {
  delete process.env.WATCH_LIFECYCLE_ENABLED;   // default OFF
  const res = await request(app).post('/ops/lifecycle/run').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: false, reason: 'disabled' });
  assert.equal(sqlLog.length, 0, 'no DB work (no ensureTables/segments/log) when disabled');
});

test('kill switch ON → runs the REAL job and returns an honest summary', async () => {
  process.env.WATCH_LIFECYCLE_ENABLED = 'true';
  const res = await request(app).post('/ops/lifecycle/run').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // Side effect only the REAL runLifecycle produces (not a stub): it logged the run.
  assert.ok(sqlLog.some((s) => /INSERT INTO lifecycle_runs/i.test(s)), 'real job logged the run');
  // Honest empty result on an empty user base — nothing padded.
  assert.equal(res.body.paused, false);         // circuit breaker not tripped
  assert.equal(res.body.sent, 0);
  assert.equal(res.body.planned, 0);
  assert.deepEqual(res.body.bySegment, {});     // per-segment match counts (all zero here)
  assert.equal(typeof res.body.threshold, 'number');
});
