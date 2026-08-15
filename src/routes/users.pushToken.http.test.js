// DELETE /users/me/push-token — the logout-hygiene fix.
//
// Neither /auth/logout nor /auth/logout-all used to touch push_tokens at
// all — only account deletion did, via CASCADE — and there was no
// client-callable unregister route at all. On a shared/resold/lent device
// where the app isn't reinstalled, that left the PREVIOUS account's push
// token live indefinitely: whoever logs into their own account next on
// that physical device kept getting the old owner's message previews,
// connect-request names, and vouch alerts. This route lets the client
// explicitly remove its token as part of sign-out. pool/auth stubbed.
// node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let deleteCalls = [];
let currentUser = { id: 'u1', email: 'a@ohio.edu', is_banned: false };
inject('../db/pool', {
  query: async (sql, params) => {
    if (/DELETE FROM push_tokens WHERE token = \$1 AND user_id = \$2/.test(sql)) {
      deleteCalls.push({ sql, params });
      // Simulate: a token that exists and belongs to this user is removed.
      return { rowCount: params[0] === 'stale-token' ? 1 : 0 };
    }
    if (/DELETE FROM push_tokens WHERE user_id = \$1/.test(sql)) {
      deleteCalls.push({ sql, params });
      return { rowCount: 3 };
    }
    return { rows: [], rowCount: 0 };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = currentUser; next(); },
  refuseBanned: (req, res, next) => (req.user?.is_banned ? res.status(403).json({ banned: true }) : next()),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/users', require('./users'));

test.beforeEach(() => { deleteCalls = []; currentUser = { id: 'u1', email: 'a@ohio.edu', is_banned: false }; });

test('unregistering a token you own removes it, scoped to token + your own user_id', async () => {
  const res = await request(app).delete('/users/me/push-token').send({ token: 'stale-token' });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.removed, 1);
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(deleteCalls[0].params, ['stale-token', 'u1']);
});

test('unregistering a token that does not exist (or is not yours) is still a clean 200, removed:0', async () => {
  const res = await request(app).delete('/users/me/push-token').send({ token: 'someone-elses-token' });
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, 0);
});

test('no token in the body clears EVERY token this user has registered', async () => {
  const res = await request(app).delete('/users/me/push-token').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, 3);
  assert.equal(deleteCalls[0].params.length, 1, 'scoped only by user_id, no token filter');
  assert.deepEqual(deleteCalls[0].params, ['u1']);
});

test('a non-string/empty token is rejected with 400, not silently treated as "clear all"', async () => {
  const res = await request(app).delete('/users/me/push-token').send({ token: '' });
  assert.equal(res.status, 400);
  assert.equal(deleteCalls.length, 0);
});
