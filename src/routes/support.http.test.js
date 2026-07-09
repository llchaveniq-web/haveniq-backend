// HTTP tests for the support-triage queue. Mounts the REAL support router
// (real requireModerator gate via the real utils/founders) and drives it with
// supertest; DB / auth / email are stubbed via the require cache — no live DB,
// JWT, or Resend needed.
const test = require('node:test');
const assert = require('node:assert');

// Roles resolved from env by the REAL utils/founders (isModeratorUser).
process.env.FOUNDER_USER_IDS = 'founder-1';
process.env.MODERATOR_EMAILS = 'mod@school.edu';

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let emailCalls = [];
let dbCalls = [];

const fakePool = {
  query: async (sql, params = []) => {
    dbCalls.push({ sql, params });
    // reply: single-report lookup
    if (sql.includes('u.email, u.first_name') && sql.includes('WHERE r.id = $1')) {
      if (params[0] === 'missing') return { rows: [] };
      if (params[0] === 'no-email') return { rows: [{ id: params[0], message: 'help', user_id: 'u-9', email: null, first_name: null }] };
      return { rows: [{ id: params[0], message: 'the button is broken', user_id: 'u-1', email: 'student@school.edu', first_name: 'Sam' }] };
    }
    // GET queue list
    if (sql.includes('FROM user_problem_reports r') && sql.includes('ORDER BY')) {
      return { rows: [{ id: 'r-1', message: 'help', status: 'open', email: 'student@school.edu', first_name: 'Sam' }] };
    }
    // reply: mark answered
    if (sql.includes("SET status = 'answered'")) return { rows: [] };
    // PATCH status
    if (sql.includes('SET status = $1')) {
      if (params[2] === 'missing') return { rows: [] };
      return { rows: [{ id: params[2], status: params[0] }] };
    }
    return { rows: [] };
  },
};

const fakeAuth = {
  requireAuth: (req, res, next) => {
    const uid = req.headers['x-test-uid'];
    req.user = uid ? { id: uid, email: req.headers['x-test-email'] || null } : null;
    if (!req.user) return res.status(401).json({ error: 'unauth' });
    next();
  },
};

const fakeEmail = { sendSupportReplyEmail: async (args) => { emailCalls.push(args); } };
const fakeAudit = { audit: async () => {} };

inject('../db/pool', fakePool);
inject('../middleware/auth', fakeAuth);
inject('../services/email', fakeEmail);
inject('../services/auditLog', fakeAudit);

const express = require('express');
const request = require('supertest');
const supportRouter = require('./support');

const app = express();
app.use(express.json());
app.use('/admin/support', supportRouter);

const asFounder   = (r) => r.set('x-test-uid', 'founder-1');
const asModerator = (r) => r.set('x-test-uid', 'mod-1').set('x-test-email', 'mod@school.edu');
const asStranger  = (r) => r.set('x-test-uid', 'nobody').set('x-test-email', 'nobody@school.edu');

test.beforeEach(() => { emailCalls = []; dbCalls = []; });

test('non-moderator gets 403 on every support route', async () => {
  for (const req of [
    asStranger(request(app).get('/admin/support')),
    asStranger(request(app).post('/admin/support/r-1/reply').send({ message: 'hi' })),
    asStranger(request(app).patch('/admin/support/r-1').send({ status: 'closed' })),
  ]) {
    const res = await req;
    assert.strictEqual(res.status, 403);
  }
  assert.strictEqual(emailCalls.length, 0, 'a stranger must never trigger an email');
});

test('founder can list the queue', async () => {
  const res = await asFounder(request(app).get('/admin/support'));
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.reports));
});

test('a designated MODERATOR (not founder) can also triage', async () => {
  const res = await asModerator(request(app).get('/admin/support'));
  assert.strictEqual(res.status, 200);
});

test('reply: emails the student and marks answered', async () => {
  const res = await asFounder(request(app).post('/admin/support/r-1/reply').send({ message: 'Fixed it — try again now.' }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(emailCalls.length, 1);
  assert.strictEqual(emailCalls[0].toEmail, 'student@school.edu');
  assert.match(emailCalls[0].replyBody, /Fixed it/);
  assert.ok(dbCalls.some(c => c.sql.includes("SET status = 'answered'")), 'must mark the report answered');
});

test('reply: empty message → 400, no email', async () => {
  const res = await asFounder(request(app).post('/admin/support/r-1/reply').send({ message: ' ' }));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(emailCalls.length, 0);
});

test('reply: unknown report → 404', async () => {
  const res = await asFounder(request(app).post('/admin/support/missing/reply').send({ message: 'hello' }));
  assert.strictEqual(res.status, 404);
  assert.strictEqual(emailCalls.length, 0);
});

test('reply: user with no email on file → 409, no email attempted', async () => {
  const res = await asFounder(request(app).post('/admin/support/no-email/reply').send({ message: 'hello' }));
  assert.strictEqual(res.status, 409);
  assert.strictEqual(emailCalls.length, 0);
});

test('patch status: valid → success; invalid → 400', async () => {
  const ok = await asModerator(request(app).patch('/admin/support/r-1').send({ status: 'closed' }));
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.report.status, 'closed');

  const bad = await asFounder(request(app).patch('/admin/support/r-1').send({ status: 'banana' }));
  assert.strictEqual(bad.status, 400);
});
