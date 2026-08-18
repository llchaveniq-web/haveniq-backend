// refuseBanned's 403 must never include ban_reason — the 2026-05-24
// user_bans migration says it explicitly: "founder-only, never shown to
// the banned user." It's a moderator's free-text triage note that can
// name the report/reporter that triggered the ban; the old code put it
// straight in the response body on every write route that stacks
// refuseBanned (15+ call sites).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';

const { test } = require('node:test');
const assert = require('node:assert');
const { refuseBanned } = require('./auth');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('refuseBanned 403s a banned user without leaking ban_reason', () => {
  const req = { user: { is_banned: true, ban_reason: 'Reported for harassment by user abc-123, see report #45' } };
  const res = fakeRes();
  let nextCalled = false;
  refuseBanned(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'must not call next() for a banned user');
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.banned, true);
  assert.strictEqual('banReason' in res.body, false, 'banReason key must not be in the response at all');
  assert.ok(!JSON.stringify(res.body).includes('harassment'), 'the moderator note must not appear anywhere in the payload');
  assert.ok(!JSON.stringify(res.body).includes('abc-123'), 'must not leak a reporter/report reference either');
});

test('refuseBanned calls next() for a non-banned user', () => {
  const req = { user: { is_banned: false } };
  const res = fakeRes();
  let nextCalled = false;
  refuseBanned(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null, 'should not touch the response at all');
});
