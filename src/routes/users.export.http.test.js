// GET /users/me/export — GDPR Article 15 completeness fix.
//
// The export already covered quiz answers, messages, matches, reviews,
// checklists, etc. — but not roommate_vouches (vouch notes the user wrote
// about a past roommate) or safety reports the user FILED, despite the
// download screen's own copy promising "everything HavenIQ has about you".
// This locks: both new sections are present, safety reports about the user
// (not filed by them) are correctly excluded (a report under active safety
// review shouldn't tip off its subject via their own data export), and a
// still-secrets-stripped profile / other existing sections are untouched.
// pool/auth stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const USER_ID = 'u-1';
let vouchesResult = { rows: [{ id: 'v-1', from_user_id: USER_ID, about_user_id: 'other-1', status: 'confirmed' }] };
let safetyReportsResult = { rows: [{ id: 'r-1', reported_id: 'other-2', category: 'Other safety concern', status: 'open' }] };
let vouchesShouldThrow = false;

inject('../db/pool', {
  query: async (sql, params) => {
    if (/FROM users\s+WHERE id\s*=/.test(sql)) return { rows: [{ id: USER_ID, email: 'a@ohio.edu', totp_secret: 'shh' }] };
    if (/FROM roommate_vouches WHERE from_user_id = \$1 OR about_user_id = \$1/.test(sql)) {
      if (vouchesShouldThrow) throw new Error('relation "roommate_vouches" does not exist');
      return vouchesResult;
    }
    if (/FROM roommate_safety_reports WHERE reporter_id = \$1/.test(sql)) {
      return safetyReportsResult;
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: USER_ID, is_banned: false }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/users', require('./users'));

test.beforeEach(() => {
  vouchesResult = { rows: [{ id: 'v-1', from_user_id: USER_ID, about_user_id: 'other-1', status: 'confirmed' }] };
  safetyReportsResult = { rows: [{ id: 'r-1', reported_id: 'other-2', category: 'Other safety concern', status: 'open' }] };
  vouchesShouldThrow = false;
});

test('the export includes vouches the user gave/received', async () => {
  const res = await request(app).get('/users/me/export');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.roommate_vouches.length, 1);
  assert.equal(body.roommate_vouches[0].id, 'v-1');
});

test('the export includes safety reports the user FILED', async () => {
  const res = await request(app).get('/users/me/export');
  const body = JSON.parse(res.text);
  assert.equal(body.safety_reports_filed.length, 1);
  assert.equal(body.safety_reports_filed[0].id, 'r-1');
});

test('the safety-reports query is scoped to reporter_id ONLY — never reported_id, never tips off the subject of an open report', async () => {
  await request(app).get('/users/me/export');
  // Covered structurally: the pool stub only matches "WHERE reporter_id = $1",
  // and the route's own query text is asserted not to reference reported_id
  // as a filter by requiring the route source uses the exact reporter-only clause.
  const routeSrc = require('fs').readFileSync(require.resolve('./users.js'), 'utf8');
  assert.match(routeSrc, /FROM roommate_safety_reports WHERE reporter_id = \$1/);
  assert.doesNotMatch(routeSrc.match(/me\/export[\s\S]{0,3000}/)[0], /reported_id\s*=\s*\$1/);
});

test('a fresh DB with no roommate_vouches table yet does not 500 the whole export', async () => {
  vouchesShouldThrow = true;
  const res = await request(app).get('/users/me/export');
  assert.equal(res.status, 200, 'the .catch fallback must keep the rest of the export working');
  const body = JSON.parse(res.text);
  assert.deepEqual(body.roommate_vouches, []);
});

test('the profile section still has secrets stripped (no regression from the new sections)', async () => {
  const res = await request(app).get('/users/me/export');
  const body = JSON.parse(res.text);
  assert.ok(!('totp_secret' in body.profile), 'stripSensitiveUser must still run');
});
