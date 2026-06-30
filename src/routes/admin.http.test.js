// HTTP-level integration tests for the founder account-support endpoints.
// We mount the REAL admin router (real requireFounder gate, real handlers) and
// drive it with supertest, but stub the DB / auth / email layers via the require
// cache so the tests need no live database, JWT, or Resend — they run anywhere.
const test = require('node:test');
const assert = require('node:assert');

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
          last_active_at: '2026-06-01T00:00:00.000Z',
        }] };
      }
      return { rows: [] }; // no such user
    }
    if (sql.includes('locked_until') && sql.includes('FROM otp_codes')) {
      const locked = params[0] === 'locked@school.edu'
        ? new Date('2026-06-29T12:00:00.000Z') : null;
      return { rows: [{ locked_until: locked }] };
    }
    if (sql.includes('SELECT email FROM users WHERE id') || sql.includes('SELECT id, email FROM users WHERE id')) {
      if (params[0] === 'missing') return { rows: [] };
      return { rows: [{ id: params[0], email: 'found@school.edu' }] };
    }
    if (sql.startsWith('DELETE FROM otp_codes')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO otp_codes')) return { rows: [] };
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
