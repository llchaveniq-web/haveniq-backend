// POST /analytics/events — the frontend's AnalyticsAPI.trackEvent() has
// called this path all along; it never existed, so match_blocked,
// safety_rate_limit_hit, checkin_answered, etc. were silently 404ing.
// This locks the route in: it accepts a named event + forwards to the
// server-side PostHog wrapper (services/analytics.js), validates input
// shape, and bounds payload size.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

const CALLER = '11111111-1111-1111-1111-111111111111';

const poolPath = path.resolve(__dirname, '../db/pool.js');
const fakePool = {
  async query(sql) {
    if (/FROM users WHERE id = \$1/.test(String(sql))) {
      return { rows: [{ id: CALLER, email: 'me@x.edu', school: 'X', first_name: 'Me',
        last_name: 'Self', is_verified: true, is_paused: false, quiz_completed: true,
        is_premium: false, trust_score: 50, is_banned: false, ban_reason: null,
        tokens_valid_after: null }] };
    }
    return { rows: [] };
  },
  on() {},
};
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: fakePool };

let tracked = [];
const analyticsPath = path.resolve(__dirname, '../services/analytics.js');
require.cache[analyticsPath] = {
  id: analyticsPath, filename: analyticsPath, loaded: true,
  exports: {
    track: (event, distinctId, properties) => tracked.push({ event, distinctId, properties }),
    EVENTS: {},
  },
};

const app = express();
app.use(express.json());
app.use('/analytics', require('./analytics'));
const auth = { Authorization: `Bearer ${jwt.sign({ userId: CALLER }, process.env.JWT_SECRET)}` };

beforeEach(() => { tracked = []; });

test('POST /analytics/events forwards a named event to server-side PostHog', async () => {
  const r = await request(app).post('/analytics/events').set(auth)
    .send({ event: 'match_blocked', properties: { matchId: 'm-1' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(tracked.length, 1);
  assert.strictEqual(tracked[0].event, 'match_blocked');
  assert.strictEqual(tracked[0].distinctId, CALLER, 'attributed to the authenticated user, not client-supplied');
  assert.deepStrictEqual(tracked[0].properties, { matchId: 'm-1' });
});

test('POST /analytics/events works with no properties', async () => {
  const r = await request(app).post('/analytics/events').set(auth).send({ event: 'signout' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(tracked[0].properties, {});
});

test('POST /analytics/events rejects a missing/non-string event', async () => {
  const r1 = await request(app).post('/analytics/events').set(auth).send({});
  assert.strictEqual(r1.status, 400);
  const r2 = await request(app).post('/analytics/events').set(auth).send({ event: 123 });
  assert.strictEqual(r2.status, 400);
  assert.strictEqual(tracked.length, 0, 'nothing forwarded on a rejected request');
});

test('POST /analytics/events rejects properties that are an array or non-object', async () => {
  const r1 = await request(app).post('/analytics/events').set(auth).send({ event: 'x', properties: [1, 2] });
  assert.strictEqual(r1.status, 400);
  const r2 = await request(app).post('/analytics/events').set(auth).send({ event: 'x', properties: 'nope' });
  assert.strictEqual(r2.status, 400);
});

test('POST /analytics/events rejects an oversized properties payload', async () => {
  const r = await request(app).post('/analytics/events').set(auth)
    .send({ event: 'x', properties: { blob: 'a'.repeat(5000) } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(tracked.length, 0);
});

test('POST /analytics/events requires auth', async () => {
  const r = await request(app).post('/analytics/events').send({ event: 'x' });
  assert.strictEqual(r.status, 401);
});
