// GET /auth/code-status — what actually happened to the verification email.
//
// The code screen used to guess. It counted to forty five and told the student
// his code was in his junk folder, which was a decent guess and sometimes
// wrong, and being confidently wrong there costs the only minute he was going
// to give us. The webhook already records email.delivered against the code row;
// this hands that one fact back to the client that asked for the code.
//
// The whole design question is WHO may ask. Keyed on an email address this
// would be a free oracle: probe any address, learn whether a signup is in
// flight and what that university's mail server did with it. So it is keyed on
// a signed handle to one row, issued to the caller of /send-code and to nobody
// else. These tests are mostly about that boundary holding.
//
// DB/email/cookie stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.JWT_SECRET = 'y'.repeat(48);

// One code row, whose delivery state the tests move around.
let row = { id: 'otp-77', delivery_status: null, delivered_at: null };
let statusReads = [];

inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/INSERT INTO otp_codes/i.test(sql)) return { rows: [{ id: row.id }] };
    if (/SELECT delivery_status, delivered_at FROM otp_codes/i.test(sql)) {
      statusReads.push(params[0]);
      return { rows: params[0] === row.id ? [row] : [] };
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

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/auth', require('./auth'));

const STUDENT = { email: 'student@student.cccd.edu', school: 'Orange Coast College', schoolDomain: 'student.cccd.edu' };
const sendCode = () => request(app).post('/auth/send-code').send(STUDENT);
const status   = (ref) => request(app).get('/auth/code-status').query(ref === undefined ? {} : { ref });

test.beforeEach(() => {
  row = { id: 'otp-77', delivery_status: null, delivered_at: null };
  statusReads = [];
});

test('send-code hands back a ref, and the ref reads that code row', async () => {
  const sent = await sendCode();
  assert.equal(sent.status, 200);
  assert.ok(sent.body.codeRef, 'no codeRef: the screen has nothing to ask with');

  row.delivery_status = 'delivered';
  row.delivered_at    = '2026-09-22T21:58:52.000Z';

  const res = await status(sent.body.codeRef);
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery, 'delivered');
  assert.ok(res.body.deliveredAt, 'the time is the convincing part: it happened, here is when');
  assert.deepEqual(statusReads, [row.id], 'read exactly the row the ref names');
});

test('a delayed message is reported as delayed, not as nothing', async () => {
  const { body } = await sendCode();
  row.delivery_status = 'delayed';
  // "Your school is holding it up, it should still land" and "we have heard
  // nothing" are different sentences, and only one of them is worth waiting on.
  assert.equal((await status(body.codeRef)).body.delivery, 'delayed');
});

test('no event yet reads as nothing, which is honest rather than reassuring', async () => {
  const { body } = await sendCode();
  const res = await status(body.codeRef);
  assert.equal(res.body.delivery, null);
  assert.equal(res.body.deliveredAt, null);
});

// ── the boundary ──
test('a missing or garbage ref answers nothing, and never 500s', async () => {
  for (const ref of [undefined, '', 'not-a-token', 'a.b.c']) {
    const res = await status(ref);
    assert.equal(res.status, 200, `status ${res.status} for ref ${JSON.stringify(ref)}`);
    assert.equal(res.body.delivery, null);
  }
  assert.deepEqual(statusReads, [], 'a bad ref must not reach the database at all');
});

test('a token signed with our secret for a DIFFERENT purpose is refused', async () => {
  // Everything in this system is signed with JWT_SECRET, so without the purpose
  // check a plain session token would be accepted here and its userId read as
  // an otp row id. This is the test that makes the purpose claim load-bearing.
  const session = jwt.sign({ userId: 'otp-77' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  row.delivery_status = 'delivered';
  const res = await status(session);
  assert.equal(res.body.delivery, null);
  assert.deepEqual(statusReads, [], 'a session token must not read a code row');
});

test('a ref signed with a different secret is refused', async () => {
  const forged = jwt.sign({ otpId: 'otp-77', purpose: 'otp-status' }, 'z'.repeat(48), { expiresIn: '1h' });
  row.delivery_status = 'delivered';
  assert.equal((await status(forged)).body.delivery, null);
  assert.deepEqual(statusReads, []);
});

test('an expired ref is refused', async () => {
  const stale = jwt.sign({ otpId: 'otp-77', purpose: 'otp-status' }, process.env.JWT_SECRET, { expiresIn: -60 });
  row.delivery_status = 'delivered';
  assert.equal((await status(stale)).body.delivery, null);
});

test('the answer carries nothing but the delivery state', async () => {
  const { body } = await sendCode();
  row.delivery_status = 'delivered';
  row.delivered_at    = '2026-09-22T21:58:52.000Z';
  const res = await status(body.codeRef);
  // No address, no code, no attempt count, no row id. A screen only needs the
  // one word, and anything else here is a thing that can leak later.
  assert.deepEqual(Object.keys(res.body).sort(), ['deliveredAt', 'delivery']);
  assert.ok(!JSON.stringify(res.body).includes(STUDENT.email));
  assert.ok(!JSON.stringify(res.body).includes('otp-77'));
});

test('a ref for a row that no longer exists answers nothing', async () => {
  const ghost = jwt.sign({ otpId: 'otp-gone', purpose: 'otp-status' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const res = await status(ghost);
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery, null);
});
