// Roommate safety reports (Patch 2, corrected). The load-bearing checks: the
// route module LOADS (the original imported a non-existent requireAdmin, which
// crashed the server at boot), validation holds, and the admin view is
// founder-gated and computes the same-person-different-reporters pattern.
// pool/auth stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let inserts = [];
let adminRows = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [] };
    if (/INSERT INTO roommate_safety_reports/.test(sql)) {
      inserts.push(params);
      return { rows: [{ id: 'report-1' }] };
    }
    if (/FROM roommate_safety_reports r\s+JOIN users/.test(sql)) return { rows: adminRows };
    if (/FROM roommate_safety_reports/.test(sql)) return { rows: [{ id: 'r1', reported_id: 'x', category: 'Other safety concern', detail: null, created_at: 'now' }] };
    return { rows: [] };
  },
});

let currentUser = { id: 'reporter-1', email: 'a@ohio.edu' };
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = currentUser; next(); },
  refuseBanned: (_q, _s, n) => n(),
});
// Real requireFounder against a stubbed founder id.
process.env.FOUNDER_USER_IDS = 'founder-1';

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/roommate-safety-reports', require('./roommateSafety'));

const asUser = (id) => { currentUser = { id, email: id + '@ohio.edu' }; };
test.beforeEach(() => { inserts = []; adminRows = []; asUser('reporter-1'); });

// ── The regression that matters most ──
test('the module loads and mounts (the original crashed on a missing requireAdmin)', async () => {
  // A boot-time crash from a missing handler would have thrown at require()
  // time, before this file could even build `app`. Prove it's live by getting a
  // real response from a mounted route (not a 404).
  const res = await request(app).get('/roommate-safety-reports/mine');
  assert.notEqual(res.status, 404, 'the router is mounted and responding');
});

// ── POST validation ──
test('a valid report is saved', async () => {
  const res = await request(app).post('/roommate-safety-reports')
    .send({ reportedId: 'user-2', category: 'Threats or intimidation', detail: 'context' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.id, 'report-1');
  assert.equal(inserts.length, 1);
});

test('reportedId is required', async () => {
  const res = await request(app).post('/roommate-safety-reports').send({ category: 'Physical aggression' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /reportedId/);
});

test('an off-list category is rejected (must match the frontend vocab)', async () => {
  const res = await request(app).post('/roommate-safety-reports')
    .send({ reportedId: 'user-2', category: 'made up' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /category/i);
});

test('you cannot report yourself', async () => {
  const res = await request(app).post('/roommate-safety-reports')
    .send({ reportedId: 'reporter-1', category: 'Other safety concern' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /yourself/i);
});

test('detail is capped at 2000 chars', async () => {
  await request(app).post('/roommate-safety-reports')
    .send({ reportedId: 'user-2', category: 'Other safety concern', detail: 'x'.repeat(5000) });
  assert.equal(inserts[0][3].length, 2000);
});

// ── /mine ──
test('GET /mine returns the reporter\'s own history', async () => {
  const res = await request(app).get('/roommate-safety-reports/mine');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.reports));
});

// ── Admin: gate + pattern detection ──
test('a non-founder cannot read the admin view', async () => {
  asUser('random-student');
  assert.equal((await request(app).get('/roommate-safety-reports/admin')).status, 403);
});

test('the founder gets reports + PATTERNS (same reported, distinct reporters)', async () => {
  asUser('founder-1');
  adminRows = [
    { id: 'a', category: 'Physical aggression', detail: null, created_at: 't1', reporter_id: 'rep-A', reporter_first_name: 'A', reported_id: 'BAD', reported_first_name: 'Bad' },
    { id: 'b', category: 'Threats or intimidation', detail: null, created_at: 't2', reporter_id: 'rep-B', reporter_first_name: 'B', reported_id: 'BAD', reported_first_name: 'Bad' },
    { id: 'c', category: 'Other safety concern', detail: null, created_at: 't3', reporter_id: 'rep-A', reporter_first_name: 'A', reported_id: 'OK', reported_first_name: 'Ok' },
  ];
  const res = await request(app).get('/roommate-safety-reports/admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.reports.length, 3);
  // BAD reported by two DISTINCT reporters ⇒ a pattern. OK reported once ⇒ not.
  assert.equal(res.body.patterns.length, 1);
  assert.equal(res.body.patterns[0].reportedId, 'BAD');
  assert.equal(res.body.patterns[0].distinctReporterCount, 2);
});

test('the SAME reporter filing twice is NOT a pattern (distinct reporters only)', async () => {
  asUser('founder-1');
  adminRows = [
    { id: 'a', category: 'Escalating pattern of conflict', detail: null, created_at: 't1', reporter_id: 'rep-A', reporter_first_name: 'A', reported_id: 'BAD', reported_first_name: 'Bad' },
    { id: 'b', category: 'Escalating pattern of conflict', detail: null, created_at: 't2', reporter_id: 'rep-A', reporter_first_name: 'A', reported_id: 'BAD', reported_first_name: 'Bad' },
  ];
  const res = await request(app).get('/roommate-safety-reports/admin');
  assert.equal(res.body.patterns.length, 0, 'one person filing twice is not corroboration');
});
