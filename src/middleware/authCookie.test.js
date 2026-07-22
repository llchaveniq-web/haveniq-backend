// Ensure the module-load JWT_SECRET guard passes when this test requires auth.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';

const { test } = require('node:test');
const assert = require('node:assert');
const { readTokenCookie, setSessionCookie, clearSessionCookie } = require('../lib/sessionCookie');
const { extractSessionToken, csrfGuard, sessionRevoked } = require('./auth');

// ── sessionRevoked (POST /auth/logout-all revocation) ───────────────────────
test('sessionRevoked: token issued BEFORE the cutoff is revoked; after is not', () => {
  const now = Date.now();
  const iatSec = Math.floor(now / 1000);
  // cutoff 1h in the FUTURE relative to this token → revoked
  assert.strictEqual(sessionRevoked(iatSec, new Date(now + 3600e3).toISOString()), true);
  // cutoff 1h in the PAST → token issued after → NOT revoked
  assert.strictEqual(sessionRevoked(iatSec, new Date(now - 3600e3).toISOString()), false);
  // NULL/absent cutoff → never revoked (deploy-safe: existing tokens unaffected)
  assert.strictEqual(sessionRevoked(iatSec, null), false);
  assert.strictEqual(sessionRevoked(iatSec, undefined), false);
  // missing iat → don't revoke (fail-open on a malformed token; verify already ran)
  assert.strictEqual(sessionRevoked(undefined, new Date(now + 3600e3).toISOString()), false);
});

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
test('setSessionCookie: active by default (unset env) — sets the cookie', () => {
  delete process.env.COOKIE_AUTH_ENABLED;
  const res = mkRes();
  setSessionCookie(res, 'tok');
  assert.strictEqual(res.cookieCalls.length, 1, 'cookie set by default now the API is same-site');
});
test('setSessionCookie: kill-switch — COOKIE_AUTH_ENABLED=false disables it', () => {
  process.env.COOKIE_AUTH_ENABLED = 'false';
  const res = mkRes();
  setSessionCookie(res, 'tok');
  assert.strictEqual(res.cookieCalls.length, 0, 'explicit =false is a no-op (emergency revert)');
  delete process.env.COOKIE_AUTH_ENABLED;
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
test('csrfGuard: kill-switch (COOKIE_AUTH_ENABLED=false) makes it inert', () => {
  process.env.COOKIE_AUTH_ENABLED = 'false';
  const { nexted } = runGuard({ method: 'POST', headers: { cookie: 'hq_session=x' } });
  assert.strictEqual(nexted, true, 'explicit disable → no CSRF enforcement');
  delete process.env.COOKIE_AUTH_ENABLED;
});
test('csrfGuard (default on): GET and cookieless mutations pass; cookie mutation needs the header', () => {
  delete process.env.COOKIE_AUTH_ENABLED;   // default = enabled

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
});
