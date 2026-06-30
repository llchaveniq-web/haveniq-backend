// The founder gate that protects the account-support endpoints
// (GET /admin/users/lookup, POST /admin/users/:id/resend-otp,
//  POST /admin/users/:id/unlock) — same gate + 403 as the rest of /admin.
// admin.js can't be imported here (it eagerly requires the pg pool, absent in
// CI), so we test the exact middleware all three routes share. node --test.
const test = require('node:test');
const assert = require('node:assert');

// Pin a known founder id BEFORE the gate runs (getFounderIds reads env per call).
process.env.FOUNDER_USER_IDS = 'founder-1';
const { requireFounder } = require('./requireFounder');

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// The three founder account-support routes all mount this same gate.
const ROUTES = [
  'GET /admin/users/lookup',
  'POST /admin/users/:id/resend-otp',
  'POST /admin/users/:id/unlock',
];

test('non-founder gets 403 on each founder account-support route', () => {
  for (const route of ROUTES) {
    const res = mockRes();
    let nexted = false;
    requireFounder({ user: { id: 'some-random-user' } }, res, () => { nexted = true; });
    assert.equal(res.statusCode, 403, `${route} must 403 for a non-founder`);
    assert.deepEqual(res.body, { error: 'Founders only' });
    assert.equal(nexted, false, `${route} must NOT reach the handler for a non-founder`);
  }
});

test('founder passes the gate (next called, no 403)', () => {
  const res = mockRes();
  let nexted = false;
  requireFounder({ user: { id: 'founder-1' } }, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
});

test('unauthenticated / missing user is rejected 403, never a crash', () => {
  for (const user of [undefined, {}, { id: null }]) {
    const res = mockRes();
    let nexted = false;
    requireFounder({ user }, res, () => { nexted = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nexted, false);
  }
});
