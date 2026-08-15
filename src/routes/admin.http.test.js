// HTTP-level integration tests for the founder account-support endpoints.
// We mount the REAL admin router (real requireFounder gate, real handlers) and
// drive it with supertest, but stub the DB / auth / email layers via the require
// cache so the tests need no live database, JWT, or Resend — they run anywhere.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// Pin a founder id before anything reads it (founders.js reads env per call).
process.env.FOUNDER_USER_IDS = 'founder-1';
const FOUNDER = 'founder-1';
const STRANGER = 'not-a-founder';

// ── Stub the modules admin.js pulls in, BEFORE requiring it ───────────────────
function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// Captured side effects, reset per test.
let dbCalls = [];
let emailCalls = [];

// Seeded "users" for the metrics behavioral test: one REAL student + one DEMO
// (seed-domain) account. The fake pool below actually APPLIES the demo-exclusion
// WHERE clause to these, so the demo user is only counted if the filter is missing.
const SEED_USERS = [
  { email: 'real1@berkeley.edu',       is_verified: true, quiz_completed: true,  school: 'UC Berkeley' },
  { email: 'demo001@haveniq-demo.edu', is_verified: true, quiz_completed: true,  school: 'Demo University' },
];
// Use the REAL shared filter so this test tracks it automatically. A query
// "excludes demo" if its WHERE carries any of the demo ILIKE patterns.
const { isDemoEmail, DEMO_ILIKE_PATTERNS } = require('../lib/demoFilter');
const sqlExcludesDemo = (sql) => DEMO_ILIKE_PATTERNS.some((p) => sql.includes(`ILIKE '${p}'`));

// Fake pool: pattern-match the SQL our three endpoints issue.
const fakePool = {
  query: async (sql, params = []) => {
    dbCalls.push({ sql, params });
    if (sql.includes('FROM users WHERE LOWER(email)')) {
      const email = params[0];
      if (email === 'found@school.edu' || email === 'locked@school.edu') {
        return { rows: [{
          id: 'u-1', first_name: 'Sam', last_name: 'Lee', email,
          school: 'Test U', is_verified: true, is_banned: false, ban_reason: null,
          quiz_completed: true, created_at: '2026-01-01T00:00:00.000Z',
          last_active_at: '2026-06-01T00:00:00.000Z', totp_enabled: email === 'locked@school.edu',
        }] };
      }
      return { rows: [] }; // no such user
    }
    if (sql.includes('locked_until') && sql.includes('FROM otp_codes')) {
      const locked = params[0] === 'locked@school.edu'
        ? new Date('2026-06-29T12:00:00.000Z') : null;
      return { rows: [{ locked_until: locked }] };
    }
    if (sql.includes('SELECT id, email, totp_enabled FROM users WHERE id')) {
      if (params[0] === 'missing') return { rows: [] };
      return { rows: [{ id: params[0], email: 'found@school.edu', totp_enabled: params[0] === 'u-2fa-on' }] };
    }
    if (sql.includes('SELECT email FROM users WHERE id') || sql.includes('SELECT id, email FROM users WHERE id')) {
      if (params[0] === 'missing') return { rows: [] };
      return { rows: [{ id: params[0], email: 'found@school.edu' }] };
    }
    // subscription: user-exists check
    if (sql.startsWith('SELECT id FROM users WHERE id')) {
      return params[0] === 'missing' ? { rows: [] } : { rows: [{ id: params[0] }] };
    }
    // subscription row (empty until Stripe ships; 'sub-active' = a populated row)
    if (sql.includes('FROM subscriptions WHERE user_id')) {
      if (params[0] === 'sub-active') {
        return { rows: [{
          status: 'active', plan: 'haveniq_plus', price_label: '$9.99/mo',
          current_period_end: new Date('2026-07-29T00:00:00.000Z'),
          cancel_at_period_end: true, created_at: new Date('2026-06-01T00:00:00.000Z'),
        }] };
      }
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM otp_codes')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO otp_codes')) return { rows: [] };
    // ── api_keys ──
    if (sql.includes('INSERT INTO api_keys')) {
      // params = [name, key_hash, prefix] — echo back a row (NO key_hash column).
      return { rows: [{
        id: 'key-1', name: params[0], prefix: params[2],
        created_at: new Date('2026-01-01T00:00:00.000Z'), last_used_at: null, revoked: false,
      }] };
    }
    if (sql.includes('UPDATE api_keys SET revoked')) {
      if (params[0] === 'missing') return { rows: [] };
      return { rows: [{
        id: params[0], name: 'CI key', prefix: 'hq_live_abcd',
        created_at: new Date('2026-01-01T00:00:00.000Z'), last_used_at: null, revoked: true,
      }] };
    }
    if (sql.includes('FROM api_keys ORDER BY')) {
      return { rows: [
        { id: 'key-1', name: 'CI', prefix: 'hq_live_aaaa', created_at: new Date('2026-02-01T00:00:00.000Z'), last_used_at: null, revoked: false },
        { id: 'key-2', name: 'old', prefix: 'hq_live_bbbb', created_at: new Date('2026-01-01T00:00:00.000Z'), last_used_at: new Date('2026-03-01T00:00:00.000Z'), revoked: true },
      ] };
    }
    // ── /admin/metrics queries ── (apply the WHERE exclusion to the seed set)
    if (sql.includes('AS total') && sql.includes('FROM users')) {
      const pool_ = sqlExcludesDemo(sql) ? SEED_USERS.filter(u => !isDemoEmail(u.email)) : SEED_USERS;
      return { rows: [{
        total: pool_.length,
        verified: pool_.filter(u => u.is_verified).length,
        quiz_completed: pool_.filter(u => u.quiz_completed).length,
      }] };
    }
    if (sql.includes('GROUP BY school')) {
      const pool_ = sqlExcludesDemo(sql) ? SEED_USERS.filter(u => !isDemoEmail(u.email)) : SEED_USERS;
      const by = new Map();
      for (const u of pool_) {
        const s = by.get(u.school) || { school: u.school, users: 0, verified: 0, quiz_completed: 0 };
        s.users += 1; if (u.is_verified) s.verified += 1; if (u.quiz_completed) s.quiz_completed += 1;
        by.set(u.school, s);
      }
      return { rows: [...by.values()].sort((a, b) => b.users - a.users) };
    }
    if (sql.includes('FROM pairing_outcomes')) return { rows: [{ n: 7 }] };
    if (sql.includes('FROM dimension_models WHERE certified')) {
      return { rows: [{ qid: 57, type: 'complementarity' }] };
    }
    if (sql.includes('MAX(updated_at)') && sql.includes('dimension_models')) {
      return { rows: [{ last: new Date('2026-06-29T00:00:00.000Z') }] };
    }
    if (sql.includes('FROM user_reports')) return { rows: [{ n: 3 }] };
    if (sql.includes('COALESCE(is_banned')) return { rows: [{ n: 1 }] };
    return { rows: [] };
  },
};

// Fake auth: requireAuth pulls req.user from a test header (no JWT/DB).
const fakeAuth = {
  requireAuth: (req, res, next) => {
    const uid = req.headers['x-test-uid'];
    req.user = uid ? { id: uid, email: req.headers['x-test-email'] || null } : null;
    if (!req.user) return res.status(401).json({ error: 'unauth' });
    next();
  },
};

// Fake email: deterministic code, record sends (never hit Resend).
const fakeEmail = {
  generateOTP: () => '123456',
  sendOTPEmail: async (email, code) => { emailCalls.push({ email, code }); },
};

inject('../db/pool', fakePool);
inject('../middleware/auth', fakeAuth);
inject('../services/email', fakeEmail);

const express = require('express');
const request = require('supertest');
const adminRouter = require('./admin'); // real router, real requireFounder gate

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);

const asFounder  = (r) => r.set('x-test-uid', FOUNDER);
const asStranger = (r) => r.set('x-test-uid', STRANGER);

test.beforeEach(() => { dbCalls = []; emailCalls = []; });

// ── The gate: 403 for non-founders on EACH route ─────────────────────────────
test('non-founder gets 403 on each account-support route', async () => {
  const cases = [
    () => asStranger(request(app).get('/admin/users/lookup?email=found@school.edu')),
    () => asStranger(request(app).post('/admin/users/u-1/resend-otp')),
    () => asStranger(request(app).post('/admin/users/u-1/unlock')),
    () => asStranger(request(app).post('/admin/users/u-2fa-on/reset-2fa')),
    () => asStranger(request(app).get('/admin/metrics')),
    () => asStranger(request(app).get('/admin/users/u-1/subscription')),
    () => asStranger(request(app).get('/admin/api-keys')),
    () => asStranger(request(app).post('/admin/api-keys').send({ name: 'x' })),
    () => asStranger(request(app).post('/admin/api-keys/key-1/revoke')),
  ];
  for (const mk of cases) {
    const res = await mk();
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Founders only' });
  }
  // The gate ran before any DB work.
  assert.equal(dbCalls.length, 0, 'non-founder requests must never touch the DB');
});

// ── lookup ───────────────────────────────────────────────────────────────────
test('lookup: founder gets the user + locked_until null when not locked', async () => {
  const res = await asFounder(request(app).get('/admin/users/lookup?email=FOUND@school.edu'));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, 'u-1');
  assert.equal(res.body.user.email, 'found@school.edu');
  assert.equal(res.body.user.locked_until, null);
  // email was lowercased before the query.
  assert.equal(dbCalls[0].params[0], 'found@school.edu');
});

test('lookup: locked user surfaces locked_until as an ISO string', async () => {
  const res = await asFounder(request(app).get('/admin/users/lookup?email=locked@school.edu'));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.locked_until, '2026-06-29T12:00:00.000Z');
});

test('lookup: surfaces totp_enabled so a founder can see WHY someone is locked out', async () => {
  const res = await asFounder(request(app).get('/admin/users/lookup?email=locked@school.edu'));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.totp_enabled, true);
});

test('lookup: unknown email → { user: null }', async () => {
  const res = await asFounder(request(app).get('/admin/users/lookup?email=nobody@school.edu'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: null });
});

test('lookup: missing email param → 400', async () => {
  const res = await asFounder(request(app).get('/admin/users/lookup'));
  assert.equal(res.status, 400);
});

// ── resend-otp ───────────────────────────────────────────────────────────────
test('resend-otp: clears codes, emails a fresh one to the STORED email, returns {sent:true}', async () => {
  const res = await asFounder(
    request(app).post('/admin/users/u-1/resend-otp').send({ email: 'attacker@evil.com' }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sent: true });
  // Body email is ignored — the code goes to the account's stored email.
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].email, 'found@school.edu');
  assert.ok(dbCalls.some(c => c.sql.startsWith('DELETE FROM otp_codes')), 'should clear the lockout');
  assert.ok(dbCalls.some(c => c.sql.startsWith('INSERT INTO otp_codes')), 'should issue a fresh code');
});

test('resend-otp: unknown user → 404', async () => {
  const res = await asFounder(request(app).post('/admin/users/missing/resend-otp'));
  assert.equal(res.status, 404);
  assert.equal(emailCalls.length, 0);
});

// ── unlock ───────────────────────────────────────────────────────────────────
test('unlock: clears the lockout and returns locked_until null', async () => {
  const res = await asFounder(request(app).post('/admin/users/u-1/unlock'));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, 'u-1');
  assert.equal(res.body.user.locked_until, null);
  assert.ok(dbCalls.some(c => c.sql.startsWith('DELETE FROM otp_codes')));
});

test('unlock: unknown user → 404', async () => {
  const res = await asFounder(request(app).post('/admin/users/missing/unlock'));
  assert.equal(res.status, 404);
});

// ── reset-2fa ────────────────────────────────────────────────────────────────
// The one lockout resend-otp/unlock can't fix: lost phone + all 10 recovery
// codes used, previously a permanent dead end with no admin recourse at all.
test('reset-2fa: a user WITH 2FA enabled gets disabled, and it\'s audit-logged', async () => {
  const res = await asFounder(request(app).post('/admin/users/u-2fa-on/reset-2fa'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { disabled: true });
  const update = dbCalls.find(c => /UPDATE users/.test(c.sql) && /totp_enabled = FALSE/.test(c.sql));
  assert.ok(update, 'the three totp columns were cleared');
  assert.match(update.sql, /totp_secret = NULL/);
  assert.match(update.sql, /totp_recovery_codes = '\{\}'/);
  assert.deepEqual(update.params, ['u-2fa-on']);
});

test('reset-2fa: a user WITHOUT 2FA enabled → 400, never silently "succeeds"', async () => {
  const res = await asFounder(request(app).post('/admin/users/u-1/reset-2fa'));
  assert.equal(res.status, 400);
  assert.ok(!dbCalls.some(c => /UPDATE users/.test(c.sql) && /totp_enabled = FALSE/.test(c.sql)));
});

test('reset-2fa: unknown user → 404', async () => {
  const res = await asFounder(request(app).post('/admin/users/missing/reset-2fa'));
  assert.equal(res.status, 404);
});

// ── subscription ─────────────────────────────────────────────────────────────
test('subscription: existing user with no row → the none default', async () => {
  const res = await asFounder(request(app).get('/admin/users/u-1/subscription'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { subscription: {
    status: 'none', plan: null, priceLabel: null,
    currentPeriodEnd: null, cancelAtPeriodEnd: false, since: null,
  } });
});

test('subscription: unknown user → 404', async () => {
  const res = await asFounder(request(app).get('/admin/users/missing/subscription'));
  assert.equal(res.status, 404);
});

test('subscription: a populated row maps to the full shape (forward-compat)', async () => {
  const res = await asFounder(request(app).get('/admin/users/sub-active/subscription'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.subscription, {
    status: 'active', plan: 'haveniq_plus', priceLabel: '$9.99/mo',
    currentPeriodEnd: '2026-07-29T00:00:00.000Z', cancelAtPeriodEnd: true,
    since: '2026-06-01T00:00:00.000Z',
  });
});

// ── api-keys ─────────────────────────────────────────────────────────────────
test('api-keys: create returns the secret ONCE and persists only the hash', async () => {
  const res = await asFounder(request(app).post('/admin/api-keys').send({ name: 'CI deploy bot' }));
  assert.equal(res.status, 201);

  // Secret returned once, correct format.
  assert.match(res.body.secret, /^hq_live_[A-Za-z0-9_-]{32,}$/);

  // Key object: camelCase, no secret/hash leaked.
  const k = res.body.key;
  assert.equal(k.name, 'CI deploy bot');
  assert.equal(k.revoked, false);
  assert.equal(k.lastUsedAt, null);
  assert.equal(k.prefix, res.body.secret.slice(0, 12));
  assert.ok(!('key_hash' in k) && !('keyHash' in k) && !('secret' in k), 'no hash/secret in the key object');

  // Persistence: the INSERT stored the HASH, never the plaintext secret.
  const insert = dbCalls.find(c => c.sql.includes('INSERT INTO api_keys'));
  assert.ok(insert, 'an insert ran');
  assert.ok(!insert.params.includes(res.body.secret), 'plaintext secret must NOT be in the row');
  assert.ok(
    insert.params.includes(crypto.createHash('sha256').update(res.body.secret).digest('hex')),
    'the stored key_hash is sha256(secret)',
  );
});

test('api-keys: create requires a name → 400', async () => {
  const res = await asFounder(request(app).post('/admin/api-keys').send({}));
  assert.equal(res.status, 400);
});

test('api-keys: revoke flips revoked → true', async () => {
  const res = await asFounder(request(app).post('/admin/api-keys/key-1/revoke'));
  assert.equal(res.status, 200);
  assert.equal(res.body.key.id, 'key-1');
  assert.equal(res.body.key.revoked, true);
});

test('api-keys: revoke unknown key → 404', async () => {
  const res = await asFounder(request(app).post('/admin/api-keys/missing/revoke'));
  assert.equal(res.status, 404);
});

test('api-keys: list returns camelCase rows with NO hashes', async () => {
  const res = await asFounder(request(app).get('/admin/api-keys'));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.keys) && res.body.keys.length === 2);
  for (const k of res.body.keys) {
    assert.ok('id' in k && 'name' in k && 'prefix' in k && 'createdAt' in k && 'lastUsedAt' in k && 'revoked' in k);
    assert.ok(!('key_hash' in k) && !('keyHash' in k) && !('secret' in k), 'never expose hashes/secrets');
  }
});

// ── metrics ──────────────────────────────────────────────────────────────────
test('metrics: full shape, and the seeded DEMO user is NOT counted in users/schools', async () => {
  // Single request (the endpoint caches ~60s, so one compute), asserting the
  // shape AND the demo exclusion. Seed = 1 real (UC Berkeley) + 1 demo
  // (@haveniq-demo.edu / Demo University).
  const res = await asFounder(request(app).get('/admin/metrics'));
  assert.equal(res.status, 200);
  const m = res.body;
  assert.equal(typeof m.generatedAt, 'string');

  // Only the real student counts — the demo account is excluded everywhere.
  assert.deepEqual(m.users, { total: 1, verified: 1, quizCompleted: 1 });
  assert.deepEqual(m.schools, [{ school: 'UC Berkeley', users: 1, verified: 1, quizCompleted: 1 }]);
  assert.ok(!m.schools.some(s => s.school === 'Demo University'), 'a demo-only school must drop off entirely');

  // matching + safety unchanged.
  assert.equal(m.matching.outcomesLogged, 7);
  assert.deepEqual(m.matching.certifiedShapes, [{ qid: 57, type: 'complementarity' }]);
  assert.equal(m.matching.lastTrainingRun, '2026-06-29T00:00:00.000Z');
  assert.deepEqual(m.safety, { openReports: 3, bannedUsers: 1 });

  // Safety counts are intentionally NOT demo-filtered (a report on a demo
  // account still matters): the banned-count query carries no demo exclusion.
  const bannedQ = dbCalls.find(c => c.sql.includes('COALESCE(is_banned'));
  assert.ok(!sqlExcludesDemo(bannedQ.sql), 'safety (banned) count left as-is');
});
