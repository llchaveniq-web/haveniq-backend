// GET /users/:id must not be readable once either side has blocked the
// other, and must not return a banned user's profile at all — this route
// was the one profile-adjacent surface that checked neither (found in an
// audit; messages.js/matches.js already honored user_blocks in both
// directions, and search.js already excluded is_banned — this route was
// missed). Drives the REAL users router + requireAuth with a stubbed DB
// that tracks which pairs are "blocked" and which target is "banned".
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

const CALLER  = '11111111-1111-1111-1111-111111111111';
const TARGET  = '22222222-2222-2222-2222-222222222222';
const BLOCKED = '33333333-3333-3333-3333-333333333333'; // caller blocked this one
const BLOCKER = '44444444-4444-4444-4444-444444444444'; // this one blocked caller
const BANNED  = '55555555-5555-5555-5555-555555555555';

// Pairs where a block row exists, either direction.
const BLOCK_PAIRS = new Set([`${CALLER}:${BLOCKED}`, `${BLOCKER}:${CALLER}`]);

const poolPath = path.resolve(__dirname, '../db/pool.js');
const fakePool = {
  async query(sql, params) {
    const s = String(sql);
    if (/FROM users WHERE id = \$1/.test(s) && /is_banned/.test(s)) {
      return { rows: [{ id: CALLER, email: 'me@x.edu', school: 'X', first_name: 'Me',
        last_name: 'Self', is_verified: true, is_paused: false, quiz_completed: true,
        is_premium: true, trust_score: 50, is_banned: false, ban_reason: null,
        tokens_valid_after: null }] };
    }
    if (/FROM users/.test(s) && /move_in_timeline/.test(s)) {
      const [targetId, callerId] = params;
      // Simulate the actual WHERE clause instead of hardcoding the outcome —
      // the row exists in the "DB" regardless of who's asking, so this only
      // returns it if the query text itself carries the guard AND the guard's
      // condition is met, the same way a real Postgres WHERE would.
      const targetIsBanned = targetId === BANNED;
      const checksIsBanned = /is_banned/.test(s);
      if (checksIsBanned && targetIsBanned) return { rows: [] };

      const isBlockedPair =
        BLOCK_PAIRS.has(`${callerId}:${targetId}`) || BLOCK_PAIRS.has(`${targetId}:${callerId}`);
      const checksBlocks = /user_blocks/.test(s);
      if (checksBlocks && isBlockedPair) return { rows: [] };

      return { rows: [{ id: targetId, first_name: 'Bob', last_name: 'Ng', school: 'X',
        school_year: 'Senior', major: 'CS', bio: 'hi', gender: 'm', looking_for: [],
        photo_url: null, budget_min: 500, budget_max: 2000, move_in_timeline: '1 month',
        is_verified: true, trust_score: 40, quiz_completed: true }] };
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

test('GET /users/:id succeeds for an ordinary, unblocked, un-banned target', async () => {
  const r = await request(app).get(`/users/${TARGET}`).set(auth);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.id, TARGET);
});

test('GET /users/:id 404s when the CALLER has blocked the target', async () => {
  const r = await request(app).get(`/users/${BLOCKED}`).set(auth);
  assert.strictEqual(r.status, 404, 'a block must actually hide the profile, not just the conversation');
});

test('GET /users/:id 404s when the TARGET has blocked the caller (other direction)', async () => {
  const r = await request(app).get(`/users/${BLOCKER}`).set(auth);
  assert.strictEqual(r.status, 404, 'blocking must be symmetric — the blocked party cannot look the blocker up either');
});

test('GET /users/:id 404s for a banned target — a ban must hide the profile from everyone', async () => {
  const r = await request(app).get(`/users/${BANNED}`).set(auth);
  assert.strictEqual(r.status, 404);
});
