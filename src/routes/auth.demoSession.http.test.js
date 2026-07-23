// POST /auth/demo-session — the one-tap reviewer login (staging only).
//
// It mints a REAL session with no email and no OTP, so the load-bearing test is
// that production returns 404 no matter what the flags say. DB/email stubbed.
// node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.JWT_SECRET = 'x'.repeat(48);

let inserted = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/INSERT INTO users/.test(sql)) {
      inserted.push({ sql, params });
      return { rows: [{
        id: 'demo-user-1', email: params[0], school: params[1],
        first_name: 'Demo', last_name: 'Visitor', age: 20, gender: null,
        looking_for: [], is_verified: true, trust_score: 20, quiz_completed: false,
        bio: null, major: null, school_year: null, photo_url: null,
        budget_min: null, budget_max: null, neighborhoods: null,
        move_in_date: null, identity_verified_at: null, totp_enabled: false,
      }] };
    }
    return { rows: [] };
  },
});
inject('../services/email', {
  generateOTP: () => '000000', sendOTPEmail: async () => {},
  sendWelcomeEmail: async () => {}, sendFounderSignupAlert: async () => {},
});
inject('../lib/sessionCookie', {
  setSessionCookie: (res, t) => res.setHeader('set-cookie', `hq_session=${t}; HttpOnly`),
  clearSessionCookie: () => {},
  readTokenCookie: () => null,
  cookieAuthEnabled: () => true,
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/auth', require('./auth'));

const post = () => request(app).post('/auth/demo-session').send({});
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

test.beforeEach(() => { inserted = []; });

// ── Production must never expose this ──
test('PROD: 404 even with ALLOW_DEMO_SESSION=true', async () => {
  await withEnv({ RAILWAY_ENVIRONMENT: 'production', ALLOW_DEMO_SESSION: 'true' }, async () => {
    const res = await post();
    assert.equal(res.status, 404, 'a stray flag on prod must not open an auth bypass');
    assert.equal(inserted.length, 0, 'and must not create a user');
  });
});

test('PROD: 404 even if NODE_ENV is wrong', async () => {
  await withEnv({ RAILWAY_ENVIRONMENT: 'production', NODE_ENV: 'staging', ALLOW_DEMO_SESSION: 'true' },
    async () => assert.equal((await post()).status, 404));
});

test('404 (not 403) — prod looks like a build without the feature', async () => {
  await withEnv({ RAILWAY_ENVIRONMENT: 'production', ALLOW_DEMO_SESSION: 'true' }, async () => {
    const res = await post();
    assert.equal(res.status, 404);
    assert.ok(!/demo/i.test(JSON.stringify(res.body)), 'the 404 must not advertise the feature');
  });
});

test('STAGING without the flag: still 404', async () => {
  await withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: undefined },
    async () => assert.equal((await post()).status, 404));
});

// ── Staging, enabled ──
test('STAGING + flag: returns a token and the verify-code user shape', async () => {
  await withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: 'true' }, async () => {
    const res = await post();
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, 'string');
    assert.ok(res.body.token.split('.').length === 3, 'a real signed JWT');
    // The frontend reads `user`; verify-code consumers read `profile`.
    for (const key of ['user', 'profile']) {
      const u = res.body[key];
      assert.ok(u, `${key} must be present`);
      assert.equal(u.firstName, 'Demo');
      assert.equal(u.id, 'demo-user-1');
      assert.equal(typeof u.school, 'string');
      assert.equal(u.isVerified, true);
      assert.equal(u.quizCompleted, false, 'the reviewer is routed into the quiz');
    }
  });
});

test('the token is a normal session token for that user', async () => {
  await withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: 'true' }, async () => {
    const { token } = (await post()).body;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    assert.equal(payload.userId, 'demo-user-1', 'identical claim shape to a real login');
    assert.ok(payload.exp > payload.iat);
  });
});

test('each call creates a DISTINCT throwaway user', async () => {
  await withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: 'true' }, async () => {
    await post(); await post();
    assert.equal(inserted.length, 2);
    assert.notEqual(inserted[0].params[0], inserted[1].params[0], 'emails must not collide');
  });
});

test('the demo user is a .test address (kept out of other reviewers\' feeds)', async () => {
  await withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: 'true' }, async () => {
    await post();
    const email = inserted[0].params[0];
    assert.match(email, /^demo\+[0-9a-f]+@haveniq\.test$/);
    // demoFilter treats .test as a demo account, so reviewer A never sees
    // reviewer B. The SEEDS must not look like this or they'd be filtered too.
    const { isDemoEmail } = require('../lib/demoFilter');
    assert.equal(isDemoEmail(email), true);
  });
});

test('the demo user is created verified, quiz-incomplete, with open preferences', async () => {
  await withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: 'true' }, async () => {
    await post();
    const sql = inserted[0].sql;
    assert.match(sql, /is_verified/);
    // Empty looking_for + NULL gender pass the feed's two-way gender filter
    // inclusively, so the seeds are guaranteed visible.
    assert.match(sql, /'\{\}'/);
    assert.match(sql, /FALSE/, 'quiz_completed FALSE — the reviewer takes the quiz');
  });
});

test('the demo session sets the httpOnly cookie a real login sets', async () => {
  // Cookie auth is active (PR #6), so /auth/verify-code sets hq_session. A demo
  // session that skipped it would not be "identical to a real login" and any
  // cookie-authenticated path would behave differently for a reviewer.
  await withEnv({ RAILWAY_ENVIRONMENT: 'staging', ALLOW_DEMO_SESSION: 'true' }, async () => {
    const cookie = String((await post()).headers['set-cookie'] || '');
    assert.match(cookie, /hq_session=/);
    assert.match(cookie, /HttpOnly/);
  });
});
