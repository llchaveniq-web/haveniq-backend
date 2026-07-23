// Peer endpoints must expose only another student's last INITIAL, never the
// full surname (policy §3 — full names are founder-gated admin only). Drives the
// REAL users router + requireAuth with a stubbed DB.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

const CALLER = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

const poolPath = path.resolve(__dirname, '../db/pool.js');
const fakePool = {
  async query(sql) {
    const s = String(sql);
    // requireAuth's caller lookup (has is_banned/tokens_valid_after)
    if (/FROM users WHERE id = \$1/.test(s) && /is_banned/.test(s)) {
      return { rows: [{ id: CALLER, email: 'me@x.edu', school: 'X', first_name: 'Me',
        last_name: 'Self', is_verified: true, is_paused: false, quiz_completed: true,
        is_premium: true, trust_score: 50, is_banned: false, ban_reason: null,
        tokens_valid_after: null }] };
    }
    // GET /users/:id public profile (has move_in_timeline)
    // Matched on COLUMNS, not the exact FROM text: the profile query gained a
    // LATERAL join for the photo gallery and now aliases the table
    // (`FROM users u ... WHERE u.id = $1`), which stopped matching the old
    // pattern and made this privacy test 404 instead of asserting anything.
    if (/FROM users/.test(s) && /move_in_timeline/.test(s)) {
      return { rows: [{ id: TARGET, first_name: 'Bob', last_name: 'Ng', school: 'X',
        school_year: 'Senior', major: 'CS', bio: 'hi', gender: 'm', looking_for: [],
        photo_url: null, budget_min: 500, budget_max: 2000, move_in_timeline: '1 month',
        is_verified: true, trust_score: 40, quiz_completed: true }] };
    }
    // GET /users/me/viewers (profile_views join)
    if (/profile_views pv/.test(s)) {
      return { rows: [{ id: '33333333-3333-3333-3333-333333333333', first_name: 'Amy',
        last_name: 'Nguyen', school: 'X', photo_url: null, viewed_at: new Date('2026-01-01') }] };
    }
    return { rows: [] };
  },
  on() {},
};
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: fakePool };

const app = express();
app.use(express.json());
app.use('/users', require('./users'));
const auth = { Authorization: `Bearer ${jwt.sign({ userId: CALLER }, process.env.JWT_SECRET)}` };

test('GET /users/:id returns only the last initial, never the full surname', async () => {
  const r = await request(app).get(`/users/${TARGET}`).set(auth);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.first_name, 'Bob', 'first name unchanged');
  assert.strictEqual(r.body.last_name, 'N', 'last_name truncated to the initial');
  assert.ok(!/Ng/.test(JSON.stringify(r.body)), 'full surname "Ng" nowhere in the payload');
});

test('GET /users/me/viewers returns only the last initial for each viewer', async () => {
  const r = await request(app).get('/users/me/viewers').set(auth);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body) && r.body.length === 1);
  assert.strictEqual(r.body[0].last_name, 'N', 'viewer surname truncated to the initial');
  assert.ok(!/Nguyen/.test(JSON.stringify(r.body)), 'full surname "Nguyen" nowhere in the payload');
});
