// Ensure the module-load JWT_SECRET guard passes when this test requires auth.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';

const { test } = require('node:test');
const assert = require('node:assert');
const { readTokenCookie, setSessionCookie, clearSessionCookie } = require('../lib/sessionCookie');
const { extractSessionToken, csrfGuard } = require('./auth');

function mkRes() {
  return {
    cookieCalls: [], clearCalls: [], statusCode: null, jsonBody: null,
    cookie(name, val, opts) { this.cookieCalls.push({ name, val, opts }); },
    clearCookie(name, opts) { this.clearCalls.push({ name, opts }); },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
  };
}
function runGuard(req) {
  const res = mkRes();
  let nexted = false;
  csrfGuard(req, res, () => { nexted = true; });
  return { nexted, res };
}

// ── readTokenCookie ─────────────────────────────────────────────────────────
test('readTokenCookie: extracts hq_session, ignores others, null when absent', () => {
  assert.strictEqual(readTokenCookie({ headers: { cookie: 'hq_session=abc123; other=1' } }), 'abc123');
  assert.strictEqual(readTokenCookie({ headers: { cookie: 'other=1; foo=bar' } }), null);
  assert.strictEqual(readTokenCookie({ headers: {} }), null);
  assert.strictEqual(readTokenCookie({ headers: { cookie: 'hq_session=' } }), null, 'blank value → null');
});

// ── extractSessionToken (header wins, cookie fallback) ──────────────────────
test('extractSessionToken: Authorization header ALWAYS wins over the cookie', () => {
  const tok = extractSessionToken({ headers: { authorization: 'Bearer HEADERTOK', cookie: 'hq_session=COOKIETOK' } });
  assert.strictEqual(tok, 'HEADERTOK');
});
test('extractSessionToken: cookie is used only when there is no bearer header', () => {
  assert.strictEqual(extractSessionToken({ headers: { cookie: 'hq_session=COOKIETOK' } }), 'COOKIETOK');
  assert.strictEqual(extractSessionToken({ headers: {} }), null);
});

// ── setSessionCookie / clearSessionCookie ───────────────────────────────────
test('setSessionCookie: no-op while COOKIE_AUTH_ENABLED is off (deploy-safe)', () => {
  delete process.env.COOKIE_AUTH_ENABLED;
  const res = mkRes();
  setSessionCookie(res, 'tok');
  assert.strictEqual(res.cookieCalls.length, 0, 'must not set a cookie until the flag is flipped');
});
test('setSessionCookie: when enabled, sets httpOnly + Secure + SameSite=Lax', () => {
  process.env.COOKIE_AUTH_ENABLED = 'true';
  const res = mkRes();
  setSessionCookie(res, 'tok');
  assert.strictEqual(res.cookieCalls.length, 1);
  const { name, val, opts } = res.cookieCalls[0];
  assert.strictEqual(name, 'hq_session');
  assert.strictEqual(val, 'tok');
  assert.strictEqual(opts.httpOnly, true);
  assert.strictEqual(opts.secure, true);
  assert.strictEqual(opts.sameSite, 'lax');
  delete process.env.COOKIE_AUTH_ENABLED;
});
test('clearSessionCookie: always clears hq_session (server-side logout)', () => {
  const res = mkRes();
  clearSessionCookie(res);
  assert.strictEqual(res.clearCalls.length, 1);
  assert.strictEqual(res.clearCalls[0].name, 'hq_session');
});

// ── csrfGuard ───────────────────────────────────────────────────────────────
test('csrfGuard: fully inert while the flag is off', () => {
  delete process.env.COOKIE_AUTH_ENABLED;
  const { nexted } = runGuard({ method: 'POST', headers: { cookie: 'hq_session=x' } });
  assert.strictEqual(nexted, true, 'no CSRF enforcement until cookie auth is enabled');
});
test('csrfGuard (enabled): GET and cookieless mutations pass; cookie mutation needs the header', () => {
  process.env.COOKIE_AUTH_ENABLED = 'true';

  // GET always passes
  assert.strictEqual(runGuard({ method: 'GET', headers: { cookie: 'hq_session=x' } }).nexted, true);

  // POST with NO session cookie (webhook / pre-login / bearer client) passes
  assert.strictEqual(runGuard({ method: 'POST', headers: {} }).nexted, true);

  // POST riding the session cookie WITHOUT the custom header → blocked 403
  const blocked = runGuard({ method: 'POST', headers: { cookie: 'hq_session=x' } });
  assert.strictEqual(blocked.nexted, false);
  assert.strictEqual(blocked.res.statusCode, 403);

  // POST riding the cookie WITH the custom header → allowed
  const ok = runGuard({ method: 'POST', headers: { cookie: 'hq_session=x', 'x-haveniq-csrf': '1' } });
  assert.strictEqual(ok.nexted, true);

  delete process.env.COOKIE_AUTH_ENABLED;
});
