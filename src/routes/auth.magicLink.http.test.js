// POST /auth/magic-link — env-gated single-account reviewer sign-in.
//
// Load-bearing: 404 when off (indistinguishable from no route); 401 on a wrong
// token; a valid token returns a real session for the ONE seeded account and
// creates no arbitrary users. DB/quiz-scoring/cookie stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.JWT_SECRET = 'x'.repeat(48);

const TOKEN = 'M'.repeat(43); // stand-in high-entropy token
let usersByEmail = new Map();
let inserts = [];
let scoreCalls = [];

const mkUser = (email, extra = {}) => ({
  id: 'u-' + email, email, school: 'University of Southern California',
  first_name: 'Chad', last_name: null, bio: null, major: null, school_year: null, age: null,
  gender: null, looking_for: [], photo_url: null, budget_min: null, budget_max: null,
  neighborhoods: null, move_in_date: null, is_verified: true, trust_score: 20,
  quiz_completed: false, identity_verified_at: null, totp_enabled: false, ...extra,
});

inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/SELECT \* FROM users WHERE email/i.test(sql)) {
      const u = usersByEmail.get(params[0]); return { rows: u ? [u] : [] };
    }
    if (/INSERT INTO users/i.test(sql)) {
      const [email, school, , name] = params;
      const u = mkUser(email, { school, first_name: name });
      usersByEmail.set(email, u); inserts.push(u); return { rows: [u] };
    }
    if (/INSERT INTO quiz_answers/i.test(sql)) return { rows: [] };
    if (/UPDATE users SET quiz_completed/i.test(sql)) {
      for (const u of usersByEmail.values()) if (u.id === params[0]) u.quiz_completed = true;
      return { rows: [] };
    }
    if (/SELECT \* FROM users WHERE id/i.test(sql)) {
      for (const u of usersByEmail.values()) if (u.id === params[0]) return { rows: [u] };
      return { rows: [] };
    }
    if (/INSERT INTO sign_in_events/i.test(sql)) return { rows: [] };
    return { rows: [] };
  },
});
// The scoring path is stubbed — we assert it's CALLED (real scoring is quiz.js's
// own tested concern), so the reviewer's feed is populated through it.
inject('./quiz', { scoreNewMatches: async (uid, answers) => { scoreCalls.push({ uid, answers }); } });
inject('../services/email', {
  generateOTP: () => '000000', sendOTPEmail: async () => {},
  sendWelcomeEmail: async () => {}, sendFounderSignupAlert: async () => {},
});
inject('../lib/sessionCookie', {
  setSessionCookie: (res, t) => res.setHeader('set-cookie', `hq_session=${t}; HttpOnly`),
  clearSessionCookie: () => {}, readTokenCookie: () => null, cookieAuthEnabled: () => true,
});
inject('../lib/rateLimit', Object.assign(() => (_q, _s, n) => n(), { ipKeyGenerator: () => 'ip' }));

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/auth', require('./auth'));

const call = (body) => request(app).post('/auth/magic-link').send(body);
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
};

test.beforeEach(() => { usersByEmail = new Map(); inserts = []; scoreCalls = []; });

test('OFF: 404 (indistinguishable from the route not existing)', async () => {
  await withEnv({ MAGIC_LINK_MODE: undefined, MAGIC_LINK_TOKEN: TOKEN }, async () => {
    const res = await call({ token: TOKEN });
    assert.equal(res.status, 404);
    assert.equal(inserts.length, 0, 'no account touched when off');
  });
});

test('ON, wrong token: 401 { ok:false }', async () => {
  await withEnv({ MAGIC_LINK_MODE: 'true', MAGIC_LINK_TOKEN: TOKEN, MAGIC_LINK_EMAIL: 'chad@haveniq.review' }, async () => {
    const res = await call({ token: 'W'.repeat(43) });
    assert.equal(res.status, 401);
    assert.equal(res.body.ok, false);
    assert.equal(inserts.length, 0);
  });
});

test('ON, wrong-length token does not throw (constant-time compare handles it)', async () => {
  await withEnv({ MAGIC_LINK_MODE: 'true', MAGIC_LINK_TOKEN: TOKEN }, async () => {
    assert.equal((await call({ token: 'short' })).status, 401);
    assert.equal((await call({})).status, 401);
  });
});

test('ON, TOKEN env missing: 401 (fails closed, never opens)', async () => {
  await withEnv({ MAGIC_LINK_MODE: 'true', MAGIC_LINK_TOKEN: undefined }, async () => {
    assert.equal((await call({ token: TOKEN })).status, 401);
  });
});

test('ON, valid token: real session for the seeded account', async () => {
  await withEnv({ MAGIC_LINK_MODE: 'true', MAGIC_LINK_TOKEN: TOKEN, MAGIC_LINK_EMAIL: 'chad@haveniq.review' }, async () => {
    const res = await call({ token: TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.token && res.body.token.split('.').length === 3, 'real signed JWT');
    assert.ok(res.body.user, 'user (verify-code profile shape) present');
    assert.equal(res.body.user.email, 'chad@haveniq.review');
    assert.equal(res.body.isNewUser, true);
    // The httpOnly cookie a real login sets.
    assert.match(String(res.headers['set-cookie'] || ''), /hq_session=/);
  });
});

test('DEFAULT (autoseed off): blank-slate — firstName empty, quiz NOT completed, NOT scored', async () => {
  // The reviewer routes through profile-setup → quiz → real scored matches like
  // any new user; it must NOT be auto-completed or pre-scored on login.
  await withEnv({ MAGIC_LINK_MODE: 'true', MAGIC_LINK_TOKEN: TOKEN }, async () => {
    const res = await call({ token: TOKEN });
    assert.equal(res.body.quizCompleted, false, 'not auto-completed');
    assert.equal(res.body.user.firstName, '', 'blank name → app routes to profile-setup');
    assert.equal(scoreCalls.length, 0, 'no auto-scoring by default');
  });
});

test('OPT-IN (MAGIC_LINK_AUTOSEED=true): the old pre-populated behavior still works', async () => {
  await withEnv({ MAGIC_LINK_MODE: 'true', MAGIC_LINK_TOKEN: TOKEN, MAGIC_LINK_AUTOSEED: 'true' }, async () => {
    const res = await call({ token: TOKEN });
    assert.equal(res.body.quizCompleted, true);
    assert.equal(scoreCalls.length, 1, 'scoreNewMatches invoked (real scoring, not hand-written)');
    const answers = scoreCalls[0].answers;
    assert.ok(answers['50'] && typeof answers['50'].index === 'number');
  });
});

test('creates ONLY the MAGIC_LINK_EMAIL account, never an arbitrary one', async () => {
  await withEnv({ MAGIC_LINK_MODE: 'true', MAGIC_LINK_TOKEN: TOKEN, MAGIC_LINK_EMAIL: 'reviewer@haveniq.review' }, async () => {
    await call({ token: TOKEN });
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].email, 'reviewer@haveniq.review');
    assert.equal(inserts[0].is_verified, true);
  });
});

test('a second valid call reuses the SAME account (isNewUser:false), no duplicate', async () => {
  await withEnv({ MAGIC_LINK_MODE: 'true', MAGIC_LINK_TOKEN: TOKEN, MAGIC_LINK_EMAIL: 'chad@haveniq.review' }, async () => {
    const a = await call({ token: TOKEN });
    assert.equal(a.body.isNewUser, true);
    const b = await call({ token: TOKEN });
    assert.equal(b.body.isNewUser, false);
    assert.equal(inserts.length, 1, 'only one INSERT total');
    // Autoseed off by default ⇒ never scores.
    assert.equal(scoreCalls.length, 0);
  });
});
