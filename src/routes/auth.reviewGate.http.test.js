// POST /auth/verify-code + /auth/verify-email — the signup review-gate fix.
//
// Load-bearing invariants:
//   1. A brand-new signup is inserted with is_verified = FALSE. Passing .edu
//      OTP proves email ownership, not that a human/bot ever screened the
//      account — that's the signup-review bot's (botAdmin.js) or founder's
//      (admin.js) job.
//   2. A RETURNING user who is still is_verified = FALSE stays FALSE across
//      logins. The old code silently auto-flipped this on every login,
//      which meant an unreviewed account only had to log in twice to earn
//      the trust badge for free — defeats the whole review gate.
//   3. A RETURNING already-verified user is unaffected (no regression).
//   4. /auth/verify-email (the "re-verify your school" self-serve flow)
//      no longer sets is_verified — it only re-confirms email control,
//      which was already proven at signup. It used to be the exact
//      loophole #2 protects against, just self-triggered instead of
//      login-triggered: tap the button, pass a trivial OTP resend to an
//      inbox you already control, instantly self-grant "Verified".
//
// DB/email/cookie/launchGate/rateLimit stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.JWT_SECRET = 'x'.repeat(48);

let usersByEmail = new Map();
let usersById = new Map();
let insertedRows = [];
let otpByEmailPurpose = new Map(); // `${email}:${purpose}` -> { id, code, used, attempts, expires_at }
let otpIdSeq = 0;

function setUser(u) {
  usersByEmail.set(u.email, u);
  usersById.set(u.id, u);
}

inject('../db/pool', {
  query: async (sql, params = []) => {
    // ── signup/login (verify-code) ──
    if (/SELECT id, code, attempts FROM otp_codes[\s\S]*purpose = 'signup'/i.test(sql)) {
      const rec = otpByEmailPurpose.get(`${params[0]}:signup`);
      return { rows: rec && !rec.used ? [{ id: rec.id, code: rec.code, attempts: rec.attempts }] : [] };
    }
    if (/UPDATE otp_codes SET attempts = attempts \+ 1/i.test(sql)) {
      for (const rec of otpByEmailPurpose.values()) {
        if (rec.id === params[0]) { rec.attempts += 1; return { rows: [{ attempts: rec.attempts }] }; }
      }
      return { rows: [] };
    }
    if (/UPDATE otp_codes SET used = TRUE WHERE id/i.test(sql)) {
      for (const rec of otpByEmailPurpose.values()) if (rec.id === params[0]) rec.used = true;
      return { rows: [] };
    }
    if (/SELECT id, email, school, first_name, last_name,\s*\n\s*is_verified, trust_score, quiz_completed/i.test(sql)) {
      const u = usersByEmail.get(params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/INSERT INTO users \(email, school, school_domain, trust_score, is_verified\)/i.test(sql)) {
      const [email, school, school_domain, ...rest] = params;
      const trust_score = params[2] !== undefined ? undefined : undefined; // unused, params order below
      const u = {
        id: 'u-' + email, email, school, school_domain,
        trust_score: params[2] === undefined ? 20 : 20,
        is_verified: params.length >= 5 ? params[4] : undefined,
        first_name: null, last_name: null, quiz_completed: false,
        identity_verified_at: null, totp_enabled: false,
      };
      // Actual bound params for this INSERT are [emailLower, school, verifiedDomain] —
      // is_verified is a literal FALSE in the SQL text, not a placeholder. Reflect that.
      u.is_verified = /VALUES \(\$1, \$2, \$3, 20, FALSE\)/.test(sql) ? false
        : /VALUES \(\$1, \$2, \$3, 20, TRUE\)/.test(sql) ? true
        : undefined;
      setUser(u);
      insertedRows.push({ sql, params, user: u });
      return { rows: [u] };
    }
    if (/UPDATE users SET is_verified = TRUE WHERE id = \$1/i.test(sql)) {
      const u = usersById.get(params[0]);
      if (u) u.is_verified = true;
      return { rows: [] };
    }
    if (/SELECT is_verified FROM users WHERE id = \$1/i.test(sql)) {
      const u = usersById.get(params[0]);
      return { rows: u ? [{ is_verified: u.is_verified }] : [] };
    }
    if (/SELECT id FROM users WHERE id = \$1/i.test(sql)) {
      const u = usersById.get(params[0]);
      return { rows: u ? [{ id: u.id }] : [] };
    }
    if (/INSERT INTO sign_in_events/i.test(sql)) return { rows: [] };

    // ── requireAuth middleware (used by verify-email/resend-verification) ──
    if (/SELECT id, email, school, first_name, last_name, is_verified, is_paused, quiz_completed, is_premium, trust_score, is_banned, ban_reason, tokens_valid_after FROM users WHERE id = \$1/i.test(sql)) {
      const u = usersById.get(params[0]);
      if (!u) return { rows: [] };
      return { rows: [{
        id: u.id, email: u.email, school: u.school, first_name: u.first_name, last_name: u.last_name,
        is_verified: u.is_verified, is_paused: false, quiz_completed: u.quiz_completed,
        is_premium: false, trust_score: u.trust_score, is_banned: false, ban_reason: null,
        tokens_valid_after: null,
      }] };
    }
    if (/UPDATE users SET last_active_at/i.test(sql)) return { rows: [] };

    // ── verify-email (re-confirmation) ──
    if (/UPDATE otp_codes SET used = TRUE\s*\n\s*WHERE email = \$1 AND purpose = 'email_verification' AND used = FALSE/i.test(sql)) {
      return { rows: [] };
    }
    if (/INSERT INTO otp_codes \(email, code, expires_at, purpose\)/i.test(sql)) {
      // purpose is an inline SQL literal here ('email_verification'), not a
      // bound param — only [email, hashedCode, expiresAt] are passed.
      const [email, hashedCode, expires_at] = params;
      const id = 'otp-' + (++otpIdSeq);
      otpByEmailPurpose.set(`${email}:email_verification`, { id, code: hashedCode, used: false, attempts: 0, expires_at });
      return { rows: [{ id }] };
    }
    if (/SELECT id, code, attempts FROM otp_codes[\s\S]*purpose = 'email_verification'/i.test(sql)) {
      const rec = otpByEmailPurpose.get(`${params[0]}:email_verification`);
      return { rows: rec && !rec.used ? [{ id: rec.id, code: rec.code, attempts: rec.attempts }] : [] };
    }
    if (/DELETE FROM otp_codes WHERE id = \$1/i.test(sql)) {
      for (const [k, rec] of otpByEmailPurpose.entries()) if (rec.id === params[0]) otpByEmailPurpose.delete(k);
      return { rows: [] };
    }

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
  usersByEmail = new Map();
  usersById = new Map();
  insertedRows = [];
  otpByEmailPurpose = new Map();
});

async function seedSignupOtp(email, code) {
  const id = 'otp-' + (++otpIdSeq);
  otpByEmailPurpose.set(`${email}:signup`, { id, code, used: false, attempts: 0, expires_at: new Date(Date.now() + 600000) });
}

function authHeader(userId) {
  const { signToken } = require('../middleware/auth');
  return `Bearer ${signToken(userId)}`;
}

// ── 1. New signup is inserted pending review ──
test('new signup via /verify-code is inserted with is_verified = FALSE', async () => {
  await seedSignupOtp('new@berkeley.edu', '123456');
  const res = await request(app).post('/auth/verify-code')
    .send({ email: 'new@berkeley.edu', code: '123456', school: 'UC Berkeley', schoolDomain: 'berkeley.edu' });
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.isVerified, false, 'new accounts start unreviewed, not auto-verified');
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].user.is_verified, false);
});

// ── 2. Returning pending user does NOT get silently auto-verified ──
test('a returning is_verified=FALSE user is NOT auto-flipped to TRUE on login', async () => {
  setUser({ id: 'u-pending', email: 'pending@berkeley.edu', school: 'UC Berkeley', is_verified: false, trust_score: 20, quiz_completed: false, totp_enabled: false });
  await seedSignupOtp('pending@berkeley.edu', '654321');
  const res = await request(app).post('/auth/verify-code')
    .send({ email: 'pending@berkeley.edu', code: '654321' });
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.isVerified, false, 'still pending — logging in again must not grant the badge');
});

// ── 3. Already-verified returning user is unaffected ──
test('a returning is_verified=TRUE user stays TRUE (no regression)', async () => {
  setUser({ id: 'u-real', email: 'real@berkeley.edu', school: 'UC Berkeley', is_verified: true, trust_score: 40, quiz_completed: true, totp_enabled: false });
  await seedSignupOtp('real@berkeley.edu', '111222');
  const res = await request(app).post('/auth/verify-code')
    .send({ email: 'real@berkeley.edu', code: '111222' });
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.isVerified, true);
});

// ── 4. /auth/verify-email no longer self-grants the badge ──
test('/auth/verify-email confirms the email but does NOT grant is_verified', async () => {
  setUser({ id: 'u-loophole', email: 'loophole@berkeley.edu', school: 'UC Berkeley', is_verified: false, trust_score: 20, quiz_completed: false, totp_enabled: false });
  const header = authHeader('u-loophole');

  const resend = await request(app).post('/auth/resend-verification').set('Authorization', header).send({});
  assert.equal(resend.status, 200);

  const rec = otpByEmailPurpose.get('loophole@berkeley.edu:email_verification');
  assert.ok(rec, 'a re-verification code was issued');

  // Real clients submit the PLAINTEXT code; the DB stores generateOTP()'s
  // hashOtp() hash (see the stub above) — '000000' is what generateOTP() is
  // stubbed to return.
  const verify = await request(app).post('/auth/verify-email').set('Authorization', header).send({ code: '000000' });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.emailConfirmed, true, 'email control IS confirmed');
  assert.equal(verify.body.isVerified, false, 'but the trust badge is NOT granted — that used to be the self-serve bypass');

  const u = usersById.get('u-loophole');
  assert.equal(u.is_verified, false, 'DB row unaffected — only the review pipeline may flip this');
});

// ── 4b. verify-email reports the TRUTH for an already-reviewed user ──
test('/auth/verify-email reports isVerified: true for an already-approved user (no false negative)', async () => {
  setUser({ id: 'u-approved', email: 'approved@berkeley.edu', school: 'UC Berkeley', is_verified: true, trust_score: 20, quiz_completed: false, totp_enabled: false });
  const header = authHeader('u-approved');
  await request(app).post('/auth/resend-verification').set('Authorization', header).send({});
  const rec = otpByEmailPurpose.get('approved@berkeley.edu:email_verification');
  assert.ok(rec, 'a re-verification code was issued');
  const verify = await request(app).post('/auth/verify-email').set('Authorization', header).send({ code: '000000' });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.isVerified, true);
});
