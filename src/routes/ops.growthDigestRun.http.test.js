// HTTP-contract test for POST /ops/growth-digest/run (founder manual trigger).
// Proves: (1) the founder gate is enforced; (2) the route calls the REAL
// growthDigest.runDigest job (not a stub) — observed via the real job's side
// effects (kill-switch short-circuit, the growth_digests INSERT, the email
// call) — and honours the kill switch. Auth/founders/pool/resend stubbed via
// the require cache; no network. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let sqlLog = [];
let stored = null;
inject('../db/pool', {
  query: async (sql, params) => {
    sqlLog.push(sql);
    if (/INSERT INTO growth_digests/i.test(sql)) {
      stored = { metrics: JSON.parse(params[0]), narrative: params[1], source: params[2], emailed_to: params[3], created_at: 't' };
      return { rows: [] };
    }
    if (/FROM growth_digests/i.test(sql)) return { rows: stored ? [stored] : [] };
    return { rows: [{}] };   // empty-safe for collectMetrics → honest all-zero funnel
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
let emailSent = 0;
inject('resend', { Resend: class { constructor() { this.emails = { send: async () => { emailSent += 1; return {}; } }; } } });

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./ops'));

test.beforeEach(() => { sqlLog = []; stored = null; emailSent = 0; delete process.env.ANTHROPIC_API_KEY; });

test('POST /ops/growth-digest/run requires a founder', async () => {
  process.env.WATCH_DIGEST_ENABLED = 'true';
  const res = await request(app).post('/ops/growth-digest/run').set('x-test-uid', 'user-1');
  assert.equal(res.status, 403);
  assert.equal(sqlLog.length, 0, 'non-founder never reaches the job');
});

test('kill switch OFF → { ok:false, reason:disabled }, and the REAL job did NOT run', async () => {
  delete process.env.WATCH_DIGEST_ENABLED;   // default OFF
  const res = await request(app).post('/ops/growth-digest/run').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: false, reason: 'disabled' });
  // Real runDigest short-circuits before any DB touch or email — guardrail intact.
  assert.equal(sqlLog.length, 0, 'no DB work when disabled');
  assert.equal(emailSent, 0, 'no email when disabled');
});

test('kill switch ON → runs the REAL job (stores + emails) and returns the digest', async () => {
  process.env.WATCH_DIGEST_ENABLED = 'true';
  const res = await request(app).post('/ops/growth-digest/run').set('x-test-uid', 'founder-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // Side effects only the REAL runDigest produces (not a stub):
  assert.ok(sqlLog.some((s) => /INSERT INTO growth_digests/i.test(s)), 'real job stored a digest');
  assert.equal(emailSent, 1, 'real job emailed the founder');
  // The digest it just produced is returned; honest zero funnel from empty data.
  assert.ok(res.body.digest, 'digest returned in the response');
  assert.equal(res.body.digest.source, 'template'); // no ANTHROPIC key → template narrative
  assert.ok(Array.isArray(res.body.digest.metrics.funnel));
});
