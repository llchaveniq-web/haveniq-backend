// Signed unsubscribe token: round-trip + every rejection path. Pure crypto, no
// DB/network. node --test.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-xxxxxx';
const test = require('node:test');
const assert = require('node:assert');
const { sign, verify } = require('./unsubscribeToken');

test('valid token round-trips to the user id + purpose', () => {
  const d = verify(sign('user-123', 'lifecycle'), 'lifecycle');
  assert.ok(d);
  assert.equal(d.userId, 'user-123');
  assert.equal(d.purpose, 'lifecycle');
});

test('tampered signature → null', () => {
  const t = sign('user-123', 'lifecycle');
  assert.equal(verify(t.slice(0, -2) + (t.endsWith('aa') ? 'bb' : 'aa'), 'lifecycle'), null);
  const body = t.split('.')[0];
  assert.equal(verify(body + '.deadbeef', 'lifecycle'), null); // wrong-length sig
});

test('expired token → null', () => {
  assert.equal(verify(sign('user-123', 'lifecycle', -1), 'lifecycle'), null); // exp in the past
});

test('wrong purpose → null (purpose scoping)', () => {
  assert.equal(verify(sign('user-123', 'other'), 'lifecycle'), null);
});

test('garbage / empty inputs → null, never throws', () => {
  for (const x of ['', 'no-dot', '.', 'a.', '.b', null, undefined, 123, {}]) {
    assert.equal(verify(x, 'lifecycle'), null);
  }
});
