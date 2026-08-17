// GET /admin/safety/users/:id — the roommate-safety-report visibility fix.
//
// This is the actual ban/no-ban decision screen a moderator opens. It only
// ever joined the generic `user_reports` table. The dedicated roommate-
// safety-report flow (routes/roommateSafety.js, the surface with
// "Physical aggression" / "Threats or intimidation" as report categories)
// is a SEPARATE table — a moderator reviewing someone here had zero
// visibility into it, even though it's the highest-severity report
// category in the app. Locks that roommate_safety_reports rows now show
// up here, and that a missing/not-yet-created table degrades to an honest
// empty list rather than a 500. pool/auth stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let roommateSafetyRows = [];
let roommateSafetyTableMissing = false;

inject('../db/pool', {
  query: async (sql, params) => {
    if (/FROM users WHERE id = \$1/.test(sql)) {
      return { rows: [{ id: params[0], email: 'jane@ohio.edu', first_name: 'Jane', last_name: 'D', school: 'Ohio University', is_banned: false, is_paused: false, trust_score: 40, quiz_completed: true, created_at: '2026-01-01' }] };
    }
    if (/FROM user_reports\s+WHERE reported_id/.test(sql)) return { rows: [] };
    if (/FROM user_reports\s+WHERE reporter_id/.test(sql)) return { rows: [] };
    if (/FROM user_blocks WHERE blocked_id/.test(sql)) return { rows: [{ n: 0 }] };
    if (/FROM roommate_safety_reports\s+WHERE reported_id/.test(sql)) {
      if (roommateSafetyTableMissing) throw new Error('relation "roommate_safety_reports" does not exist');
      return { rows: roommateSafetyRows };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'mod-1', email: 'mod@haveniq.org' }; next(); },
});
inject('../utils/founders', {
  isModeratorUser: () => true,
  isFounderUser: () => false,
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/admin/safety', require('./adminSafety'));

test.beforeEach(() => {
  roommateSafetyRows = [];
  roommateSafetyTableMissing = false;
});

test('roommate-safety reports against this user are included in the detail view', async () => {
  roommateSafetyRows = [
    { id: 'rsr-1', category: 'Physical aggression', detail: 'x', status: 'open', created_at: '2026-08-01', reporter_id: 'reporter-1' },
  ];
  const res = await request(app).get('/admin/safety/users/target-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.roommateSafetyReportsAgainst.length, 1);
  assert.equal(res.body.roommateSafetyReportsAgainst[0].category, 'Physical aggression');
});

test('a user with no roommate-safety reports gets an honest empty array, not an absent field', async () => {
  const res = await request(app).get('/admin/safety/users/target-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.roommateSafetyReportsAgainst, []);
});

test('the table not existing yet degrades to an empty list, not a 500', async () => {
  roommateSafetyTableMissing = true;
  const res = await request(app).get('/admin/safety/users/target-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.roommateSafetyReportsAgainst, []);
});

test('the rest of the detail payload (profile, generic reports, block count) is unaffected', async () => {
  const res = await request(app).get('/admin/safety/users/target-1');
  assert.equal(res.body.profile.email, 'jane@ohio.edu');
  assert.deepEqual(res.body.reportsAgainst, []);
  assert.equal(res.body.blockCount, 0);
});
