// POST /auth/send-code — the env-gated SKIP_EMAIL_VERIFICATION branch.
//
// The load-bearing invariants: OFF ⇒ today's exact behavior (a non-.edu email is
// still rejected, no session minted); ON ⇒ a non-.edu email creates-or-finds a
// user and returns a real session, tagged for cleanup, with NO OTP ever touched.
// DB/email/cookie stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.JWT_SECRET = 'x'.repeat(48);

// A tiny in-memory users table keyed by email.
let usersByEmail = new Map();
let insertedRows = [];
let otpWrites = 0;

const mkUser = (email, extra = {}) => ({
  id: 'u-' + email, email, school: extra.school ?? 'University of Southern California',
  first_name: '', last_name: null, bio: null, major: null, school_year: null, age: null,
  gender: null, looking_for: [], photo_url: null, budget_min: null, budget_max: null,
  neighborhoods: null, move_in_date: null, is_verified: true, trust_score: 20,
  quiz_completed: false, identity_verified_at: null, totp_enabled: false,
  created_via_skip_verification: false, ...extra,
});

inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/INSERT INTO otp_codes/i.test(sql)) { otpWrites++; return { rows: [{ id: 'otp-1' }] }; }
    if (/SELECT \* FROM users WHERE email/i.test(sql)) {
      const u = usersByEmail.get(params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/INSERT INTO users/i.test(sql)) {
      const [email, school, school_domain] = params;
      const u = mkUser(email, { school, school_domain, created_via_skip_verification: true });
      usersByEmail.set(email, u);
      insertedRows.push({ sql, params, user: u });
      return { rows: [u] };
    }
    if (/SELECT school, school_domain FROM users/i.test(sql)) {
      const u = usersByEmail.get(params[0]);
      return { rows: u ? [{ school: u.school, school_domain: u.school_domain }] : [] };
    }
    if (/INSERT INTO sign_in_events/i.test(sql)) return { rows: [] };
    return { rows: [] };
  },
});
inject('../services/email', {
  generateOTP: () => '000000', sendOTPEmail: async () => {},
  sendWelcomeEmail: async () => {}, sendFounderSignupAlert: async () => {},
});
inject('../lib/sessionCookie', {
  setSessionCookie: (res, t) => res.setHeader('set-cookie', `hq_session=${t}; HttpOnly`),
  clearSessionCookie: () => {}, readTokenCookie: () => null, cookieAuthEnabled: () => true,
});
// Prelaunch gate open, so OFF-mode reaches the real .edu check (not a 403 first).
inject('../lib/launchGate', { isAllowed: () => true, PRELAUNCH_MESSAGE: 'locked' });
// Passthrough the rate limiters for deterministic functional assertions. That
// the limiters STILL APPLY in skip mode is guaranteed structurally — they sit on
// the router.post('/send-code', <limiters>, handler) chain and run BEFORE the
// handler branches into skip mode — and was in fact confirmed by an earlier run
// where rapid repeats returned 429. Here we isolate the skip LOGIC.
const passthrough = () => (_req, _res, next) => next();
inject('../lib/rateLimit', Object.assign(passthrough, { ipKeyGenerator: () => 'ip' }));

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/auth', require('./auth'));

const send = (body) => request(app).post('/auth/send-code').send(body);
const withFlag = async (val, fn) => {
  const saved = process.env.SKIP_EMAIL_VERIFICATION;
  if (val === undefined) delete process.env.SKIP_EMAIL_VERIFICATION; else process.env.SKIP_EMAIL_VERIFICATION = val;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.SKIP_EMAIL_VERIFICATION; else process.env.SKIP_EMAIL_VERIFICATION = saved;
  }
};

test.beforeEach(() => { usersByEmail = new Map(); insertedRows = []; otpWrites = 0; });

// ── OFF: today's exact behavior ──
test('flag OFF: a non-.edu email is still rejected (no bypass, no session)', async () => {
  await withFlag(undefined, async () => {
    const res = await send({ email: 'chad@gmail.com', school: 'X', schoolDomain: 'x.edu' });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /School email required/i);
    assert.equal(res.body.token, undefined, 'no session minted when off');
  });
});

test('flag set to "false" (not "true") is still OFF', async () => {
  await withFlag('false', async () => {
    assert.equal((await send({ email: 'chad@gmail.com', school: 'X', schoolDomain: 'x.edu' })).status, 400);
  });
});

// ── ON: bypass ──
test('flag ON: a non-.edu email succeeds with token + profile + skipVerification', async () => {
  await withFlag('true', async () => {
    const res = await send({ email: 'chad@gmail.com' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.skipVerification, true);
    assert.ok(res.body.token && res.body.token.split('.').length === 3, 'a real signed JWT');
    assert.ok(res.body.profile, 'profile present');
    assert.equal(res.body.profile.email, 'chad@gmail.com');
    assert.equal(res.body.isNewUser, true);
    assert.equal(res.body.quizCompleted, false);
  });
});

test('flag ON: created account is tagged created_via_skip_verification=TRUE', async () => {
  await withFlag('true', async () => {
    await send({ email: 'newperson@gmail.com' });
    assert.equal(insertedRows.length, 1);
    assert.match(insertedRows[0].sql, /created_via_skip_verification/);
    assert.equal(insertedRows[0].user.created_via_skip_verification, true);
    assert.equal(insertedRows[0].user.is_verified, true);
  });
});

test('flag ON: a blank school defaults to the healthiest pool, not empty', async () => {
  await withFlag('true', async () => {
    await send({ email: 'noschool@gmail.com' });
    // params: [email, school, school_domain]
    assert.equal(insertedRows[0].params[1], 'University of Southern California');
    assert.equal(insertedRows[0].params[2], 'gmail.com', 'domain derived from the email');
  });
});

test('flag ON: NEVER writes an OTP', async () => {
  await withFlag('true', async () => {
    await send({ email: 'chad@gmail.com' });
    assert.equal(otpWrites, 0, 'skip mode must not generate/store a code');
  });
});

test('flag ON: a second call for the same email signs into the SAME account (isNewUser:false)', async () => {
  await withFlag('true', async () => {
    const a = await send({ email: 'repeat@gmail.com' });
    assert.equal(a.body.isNewUser, true);
    const b = await send({ email: 'repeat@gmail.com' });
    assert.equal(b.body.isNewUser, false, 'no duplicate account');
    assert.equal(b.body.profile.id, a.body.profile.id);
    assert.equal(insertedRows.length, 1, 'only one INSERT total');
  });
});

test('flag ON: missing email is a clean 400', async () => {
  await withFlag('true', async () => {
    assert.equal((await send({})).status, 400);
  });
});

test('the skip profile shape matches verify-code\'s profile keys exactly (no drift)', async () => {
  // verify-code's profile keys, copied from the inline object in auth.js.
  const VERIFY_CODE_KEYS = [
    'id','email','school','firstName','lastName','lastInitial','bio','major','schoolYear',
    'age','gender','lookingFor','photoUrl','budgetMin','budgetMax','neighborhoods','moveInDate',
    'isVerified','trustScore','quizCompleted','identityVerifiedAt','totpEnabled',
  ].sort();
  await withFlag('true', async () => {
    const res = await send({ email: 'shape@gmail.com' });
    assert.deepEqual(Object.keys(res.body.profile).sort(), VERIFY_CODE_KEYS);
  });
});
