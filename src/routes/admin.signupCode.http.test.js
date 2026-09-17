// POST /admin/signup-code — the founder's way to reach a student the email
// cannot. Every other rescue in admin.js keys on /users/:id, and a student
// stuck at verification has no user row, so none of them can touch him.
//
// Same harness as admin.http.test.js: the REAL router and the REAL founder
// gate, with the DB / auth / email layers injected through require.cache.
process.env.FOUNDER_USER_IDS = 'founder-1';
const FOUNDER = 'founder-1';
const STRANGER = 'not-a-founder';

const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let stored = [];
let emailCalls = [];

inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/DELETE FROM otp_codes/i.test(sql)) { stored = []; return { rows: [], rowCount: 0 }; }
    if (/INSERT INTO otp_codes/i.test(sql)) {
      stored.push({ email: params[0], code: params[1], expires: params[2] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, res, next) => {
    const uid = req.headers['x-test-uid'];
    req.user = uid ? { id: uid, email: req.headers['x-test-email'] || null } : null;
    if (!req.user) return res.status(401).json({ error: 'unauth' });
    next();
  },
});
inject('../services/email', {
  generateOTP: () => '424242',
  sendOTPEmail: async (email, code) => { emailCalls.push({ email, code }); },
});

const express = require('express');
const request = require('supertest');
const adminRouter = require('./admin');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);

test('hands the founder a usable code for an address with no account', async () => {
  stored = [];
  const res = await request(app).post('/admin/signup-code')
    .set('x-test-uid', FOUNDER).send({ email: 'rcarle21@lbcc.edu' });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, '424242');
  assert.equal(stored.length, 1, 'stored, so /verify-code will accept it');
  assert.notEqual(stored[0].code, '424242', 'hashed at rest, never cleartext');
});

test('does not mail it unless asked: the point is the OTHER channel', async () => {
  emailCalls = [];
  await request(app).post('/admin/signup-code').set('x-test-uid', FOUNDER)
    .send({ email: 'rcarle21@lbcc.edu' });
  assert.equal(emailCalls.length, 0);
  await request(app).post('/admin/signup-code').set('x-test-uid', FOUNDER)
    .send({ email: 'rcarle21@lbcc.edu', send: true });
  assert.equal(emailCalls.length, 1);
});

test('refuses a non-academic address, the same gate send-code applies', async () => {
  const res = await request(app).post('/admin/signup-code')
    .set('x-test-uid', FOUNDER).send({ email: 'someone@gmail.com' });
  assert.equal(res.status, 400);
});

test('is founder-only: it can sign anyone in, so nobody else may call it', async () => {
  const res = await request(app).post('/admin/signup-code')
    .set('x-test-uid', STRANGER).send({ email: 'rcarle21@lbcc.edu' });
  assert.equal(res.status, 403);
});
