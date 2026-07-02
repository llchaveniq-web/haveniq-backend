// End-to-end contract for one-click unsubscribe + the sender honouring it.
// Auth-free (the token IS the auth); pool stubbed via the require cache with a
// tiny flag-aware fake "users" table shared by the route and the sender. node --test.
process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xxxxxx';
process.env.API_PUBLIC_URL = 'https://api.test';
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// One fake user; the shared flag is what the route flips and the sender reads.
const user = { id: 'u1', email: 'sam@school.edu', first_name: 'Sam', opted: false };
let calls = [];
inject('../db/pool', {
  query: async (sql, params) => {
    const s = String(sql);
    calls.push(s);
    if (/UPDATE users SET lifecycle_opted_out = TRUE/.test(s)) {
      if (params[0] === user.id) user.opted = true;
      return { rowCount: 1 };
    }
    // A lifecycle segment query — return the user ONLY while not opted out
    // (simulates the ELIGIBLE `lifecycle_opted_out = FALSE` exclusion).
    if (/SELECT u\.id, u\.email, u\.first_name\s+FROM users u/.test(s)) {
      return { rows: user.opted ? [] : [{ id: user.id, email: user.email, first_name: user.first_name }] };
    }
    if (/COUNT\(\*\)::int AS n/.test(s)) return { rows: [{ n: user.opted ? 0 : 1 }] };
    return { rows: [] };
  },
});

const { sign } = require('../lib/unsubscribeToken');
const { ELIGIBLE } = require('../services/lifecycleSegments');
const { runLifecycle } = require('../services/lifecycleSender');
const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/', require('./unsubscribe'));

test.beforeEach(() => { user.opted = false; calls = []; });

test('the sender eligibility query actually excludes opted-out users', () => {
  assert.match(ELIGIBLE, /lifecycle_opted_out/); // real DB-level filter, not just the mock
});

test('valid token opts the user out (one-click POST) and the sender then skips them', async () => {
  const token = sign('u1', 'lifecycle');

  // RFC 8058 one-click: the mail client POSTs the token URL.
  const res = await request(app).post('/unsubscribe').query({ token });
  assert.equal(res.status, 200);
  assert.match(res.text, /unsubscribed/i);
  assert.ok(calls.some((s) => /UPDATE users SET lifecycle_opted_out = TRUE/.test(s)), 'opt-out written');
  assert.equal(user.opted, true);

  // Now the sender runs — the opted-out user is not planned and not sent.
  process.env.WATCH_LIFECYCLE_ENABLED = 'true';
  const r = await runLifecycle();
  assert.equal(r.sent, 0);
  assert.equal(r.planned, 0);
  assert.deepEqual(r.bySegment, {});
});

test('the lifecycle email carries the signed link + RFC 8058 headers', async () => {
  process.env.WATCH_LIFECYCLE_ENABLED = 'true';
  const captured = [];
  // user.opted=false (beforeEach) → the user IS planned; capture the send.
  const r = await runLifecycle({ sendEmail: async (m) => { captured.push(m); } });
  assert.equal(r.sent, 1);
  const msg = captured[0];
  assert.match(msg.headers['List-Unsubscribe'], /\/unsubscribe\?token=/);
  assert.equal(msg.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(msg.text, /\/unsubscribe\?token=/);   // footer link injected (text)
  assert.match(msg.html, /\/unsubscribe\?token=/);   // and HTML
});

test('invalid token → 400, changes nothing', async () => {
  const res = await request(app).post('/unsubscribe').query({ token: 'not-a-real-token' });
  assert.equal(res.status, 400);
  assert.match(res.text, /invalid or has expired/i);
  assert.ok(!calls.some((s) => /UPDATE users/.test(s)), 'no write on invalid token');
  assert.equal(user.opted, false);
});

test('expired token → 400, changes nothing (GET link)', async () => {
  const expired = sign('u1', 'lifecycle', -1);
  const res = await request(app).get('/unsubscribe').query({ token: expired });
  assert.equal(res.status, 400);
  assert.ok(!calls.some((s) => /UPDATE users/.test(s)), 'no write on expired token');
  assert.equal(user.opted, false);
});
