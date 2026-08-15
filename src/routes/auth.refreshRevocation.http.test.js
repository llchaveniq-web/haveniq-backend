// POST /auth/refresh — the logout-all revocation fix.
//
// /auth/refresh is the one endpoint deliberately allowed to consume an
// already-expired-or-expiring token (that's the whole point of a refresh
// endpoint). Previously it never checked tokens_valid_after at all, which
// completely defeated /auth/logout-all: that route exists specifically to
// let a user kill a stolen bearer token before its natural 7-day expiry by
// stamping tokens_valid_after — but an attacker holding the stolen token
// could just call /refresh right after, get back a BRAND NEW token whose
// iat is after the cutoff, and walk away with a fully valid session again.
// Now /refresh runs the exact same sessionRevoked(iat, tokens_valid_after)
// check requireAuth already runs on every normal request, against the OLD
// token being exchanged, before minting a new one.
//
// Mounts the REAL auth router. DB/email/cookie/launchGate/rateLimit
// stubbed — mirrors auth.reviewGate.http.test.js's stub shape exactly.
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.JWT_SECRET = 'x'.repeat(48);
const USER_ID = 'u-1';

let tokensValidAfter = null; // null | Date
let userExists = true;
let pushTokenDeletes = [];
let tokensValidAfterUpdates = [];
inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/SELECT id, tokens_valid_after FROM users WHERE id = \$1/i.test(sql)) {
      if (params[0] !== USER_ID || !userExists) return { rows: [] };
      return { rows: [{ id: USER_ID, tokens_valid_after: tokensValidAfter }] };
    }
    // requireAuth's own (different, wider) SELECT — needed for /auth/logout-all.
    if (/SELECT id, email, school, first_name, last_name/i.test(sql)) {
      return { rows: [{
        id: USER_ID, email: 'u@ohio.edu', school: 'X', first_name: 'A', last_name: 'B',
        is_verified: true, is_paused: false, quiz_completed: true, is_premium: false,
        trust_score: 50, is_banned: false, ban_reason: null, tokens_valid_after: tokensValidAfter,
      }] };
    }
    if (/UPDATE users SET tokens_valid_after = NOW\(\)/i.test(sql)) {
      tokensValidAfterUpdates.push(params);
      return { rows: [] };
    }
    if (/DELETE FROM push_tokens WHERE user_id = \$1/i.test(sql)) {
      pushTokenDeletes.push(params);
      return { rows: [] };
    }
    // logSignIn's INSERT and anything else — no-op.
    return { rows: [] };
  },
});
inject('../services/email', {
  generateOTP: () => '000000', sendOTPEmail: async () => {},
  sendWelcomeEmail: async () => {}, sendFounderSignupAlert: async () => {},
});
inject('../lib/sessionCookie', {
  setSessionCookie: () => {}, clearSessionCookie: () => {},
  readTokenCookie: () => null, cookieAuthEnabled: () => true,
});
inject('../lib/launchGate', { isAllowed: () => true, PRELAUNCH_MESSAGE: 'locked' });
const passthrough = () => (_req, _res, next) => next();
inject('../lib/rateLimit', Object.assign(passthrough, { ipKeyGenerator: () => 'ip' }));
inject('../lib/stagingGuard', { stagingFlag: () => false, stagingOtp: () => null, isProdEnvironment: () => false });

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/auth', require('./auth'));

test.beforeEach(() => {
  tokensValidAfter = null; userExists = true;
  pushTokenDeletes = []; tokensValidAfterUpdates = [];
});

// A token whose iat is `secondsAgo` in the past — otherwise identical to signToken().
function tokenIssued(secondsAgo) {
  const iat = Math.floor(Date.now() / 1000) - secondsAgo;
  return jwt.sign({ userId: USER_ID, iat }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

test('a token issued BEFORE the logout-all cutoff is refused — this is the fix', async () => {
  const stolen = tokenIssued(60); // issued a minute ago
  tokensValidAfter = new Date(Date.now() + 30_000); // logout-all fired 30s AFTER the token's iat
  const res = await request(app).post('/auth/refresh').send({ token: stolen });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /sign in again/i);
});

test('a token issued AFTER the logout-all cutoff still refreshes normally', async () => {
  tokensValidAfter = new Date(Date.now() - 60_000); // cutoff was a minute ago
  const fresh = tokenIssued(5); // issued 5s ago — after the cutoff
  const res = await request(app).post('/auth/refresh').send({ token: fresh });
  assert.equal(res.status, 200);
  assert.ok(res.body.token, 'a new token was minted');
});

test('no tokens_valid_after set at all (never called logout-all) → refresh works (baseline)', async () => {
  tokensValidAfter = null;
  const token = tokenIssued(5);
  const res = await request(app).post('/auth/refresh').send({ token });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

test('the exploit scenario end-to-end: steal token, victim calls logout-all, refresh must fail', async () => {
  const stolen = tokenIssued(0); // attacker's copy, iat = "now"
  // Victim discovers the theft and calls logout-all sometime after — the
  // cutoff is necessarily >= the stolen token's iat in any real timeline.
  tokensValidAfter = new Date(Date.now() + 5_000);
  const res = await request(app).post('/auth/refresh').send({ token: stolen });
  assert.equal(res.status, 401, 'the whole point of logout-all is defeated if this succeeds');
});

test('unknown/deleted user → 401, not a crash', async () => {
  userExists = false;
  const token = tokenIssued(5);
  const res = await request(app).post('/auth/refresh').send({ token });
  assert.equal(res.status, 401);
});

// ── /auth/logout-all — "everywhere" now includes push, not just API auth ──
test('logout-all stamps tokens_valid_after AND clears every push token for this user', async () => {
  const token = tokenIssued(5);
  const res = await request(app).post('/auth/logout-all').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(tokensValidAfterUpdates.length, 1);
  assert.deepEqual(tokensValidAfterUpdates[0], [USER_ID]);
  assert.equal(pushTokenDeletes.length, 1, 'push_tokens must be cleared too — "everywhere" means everywhere');
  assert.deepEqual(pushTokenDeletes[0], [USER_ID]);
});
