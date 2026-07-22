// End-to-end HTTP coverage for the httpOnly-cookie session migration, driving
// the REAL middleware (cors + csrfGuard + requireAuth + cookie helpers) with a
// stubbed DB. Mirrors the brief's verification checklist.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';
delete process.env.COOKIE_AUTH_ENABLED; // default = active

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const cors = require('cors');
const request = require('supertest');

// ── Stub the DB pool before requiring auth middleware ───────────────────────
const poolPath = path.resolve(__dirname, '../db/pool.js');
const USER_ID = '11111111-1111-1111-1111-111111111111';
const fakePool = {
  async query(sql) {
    if (/FROM users WHERE id = \$1/.test(String(sql))) {
      return { rows: [{ id: USER_ID, email: 'u@haveniq.org', school: 'X', first_name: 'A',
        last_name: 'B', is_verified: true, is_paused: false, quiz_completed: true,
        is_premium: false, trust_score: 50, is_banned: false, ban_reason: null,
        tokens_valid_after: null }] };
    }
    return { rows: [] };
  },
  on() {},
};
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: fakePool };

const { requireAuth, csrfGuard, signToken } = require('../middleware/auth');
const { setSessionCookie, clearSessionCookie } = require('../lib/sessionCookie');

// ── App mirroring server.js's relevant middleware chain ─────────────────────
const APP_ORIGIN = 'https://app.haveniq.org';
const corsOrigin = (origin, cb) => {
  if (!origin) return cb(null, true);
  if (/^https:\/\/(app\.)?haveniq\.org$/i.test(origin)) return cb(null, true);
  cb(new Error('CORS: not allowed'));
};
function makeApp() {
  const app = express();
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-HavenIQ-CSRF'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));
  app.use(express.json());
  app.use(csrfGuard);
  app.get('/users/me', requireAuth, (req, res) => res.json({ id: req.user.id }));
  app.post('/test/mutate', requireAuth, (req, res) => res.json({ ok: true }));
  app.post('/test/login', (req, res) => { const t = signToken(USER_ID); setSessionCookie(res, t); res.json({ token: t }); });
  app.post('/auth/logout', (req, res) => { clearSessionCookie(res); res.json({ success: true }); });
  return app;
}
const app = makeApp();
const validToken = signToken(USER_ID);
const cookie = (v) => `hq_session=${v}`;

test('login response Set-Cookie: hq_session HttpOnly; Secure; SameSite=Lax', async () => {
  const r = await request(app).post('/test/login');
  const sc = (r.headers['set-cookie'] || []).find(c => c.startsWith('hq_session='));
  assert.ok(sc, 'hq_session cookie is set');
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /Secure/i);
  assert.match(sc, /SameSite=Lax/i);
});

test('GET /users/me with ONLY the cookie (no bearer) → 200', async () => {
  const r = await request(app).get('/users/me').set('Cookie', cookie(validToken));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.id, USER_ID);
});

test('cookie-authed mutation WITHOUT X-HavenIQ-CSRF → 403; WITH it → 200', async () => {
  const blocked = await request(app).post('/test/mutate').set('Cookie', cookie(validToken));
  assert.strictEqual(blocked.status, 403);

  const ok = await request(app).post('/test/mutate')
    .set('Cookie', cookie(validToken)).set('X-HavenIQ-CSRF', '1');
  assert.strictEqual(ok.status, 200);
});

test('expired/garbage cookie → 401 (session-expired), never 403', async () => {
  const r = await request(app).get('/users/me').set('Cookie', cookie('garbage.not.a.jwt'));
  assert.strictEqual(r.status, 401);

  const expired = jwt.sign({ userId: USER_ID }, process.env.JWT_SECRET, { expiresIn: -10 });
  const r2 = await request(app).get('/users/me').set('Cookie', cookie(expired));
  assert.strictEqual(r2.status, 401);
});

test('POST /auth/logout clears the cookie; no cookie afterward → 401', async () => {
  const r = await request(app).post('/auth/logout');
  const sc = (r.headers['set-cookie'] || []).find(c => c.startsWith('hq_session='));
  assert.ok(sc && /hq_session=;|hq_session=;? ?Expires|Max-Age=0/i.test(sc), 'clears hq_session');
  // Browser no longer has the cookie → next call is unauthenticated → 401
  const me = await request(app).get('/users/me');
  assert.strictEqual(me.status, 401);
});

test('bearer path unchanged: bearer (no cookie) works; bearer mutation needs no CSRF header', async () => {
  const me = await request(app).get('/users/me').set('Authorization', `Bearer ${validToken}`);
  assert.strictEqual(me.status, 200);
  // Bearer isn't ambient → CSRF-exempt even for mutations, no header needed
  const mut = await request(app).post('/test/mutate').set('Authorization', `Bearer ${validToken}`);
  assert.strictEqual(mut.status, 200);
});

test('bearer WINS over cookie (transition safety)', async () => {
  // Valid bearer + garbage cookie → still 200 (bearer resolved first)
  const r = await request(app).get('/users/me')
    .set('Authorization', `Bearer ${validToken}`).set('Cookie', cookie('garbage'));
  assert.strictEqual(r.status, 200);
});

test('CORS preflight: allowed origin gets exact-origin + credentials + custom header', async () => {
  const r = await request(app).options('/test/mutate')
    .set('Origin', APP_ORIGIN)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'X-HavenIQ-CSRF, Content-Type');
  assert.strictEqual(r.headers['access-control-allow-origin'], APP_ORIGIN, 'exact origin, never *');
  assert.strictEqual(r.headers['access-control-allow-credentials'], 'true');
  assert.match(r.headers['access-control-allow-headers'] || '', /X-HavenIQ-CSRF/i);
});

test('CORS preflight: disallowed origin does NOT get an allow-origin header', async () => {
  const r = await request(app).options('/test/mutate')
    .set('Origin', 'https://evil.example.com')
    .set('Access-Control-Request-Method', 'POST');
  assert.notStrictEqual(r.headers['access-control-allow-origin'], 'https://evil.example.com');
  assert.notStrictEqual(r.headers['access-control-allow-origin'], '*');
});
