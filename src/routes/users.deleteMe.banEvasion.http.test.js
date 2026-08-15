// DELETE /users/me — ban-evasion fix.
//
// Previously this route had no refuseBanned. Since the DELETE fully removes
// the row, a banned user could delete their own account and re-signup with
// the SAME email — a fresh INSERT defaults is_banned to false — undoing a
// ban in seconds. This is the one route on the "banned users still need
// access" list (login, 2FA, support) that should NOT be on it: deletion is
// destructive, not an appeal path.
//
// pool/auth stubbed; auditLog and cloudinary run for real (both safely
// no-op in a test env with no CLOUDINARY_* configured / a stubbed pool).
// node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let deleteCalls = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/DELETE FROM users WHERE id = \$1/.test(sql)) {
      deleteCalls.push(params);
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
});

let currentUserBanned = false;
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'u1', email: 'a@ohio.edu', is_banned: currentUserBanned }; next(); },
  // Real conditional — proves DELETE /me actually stacks this middleware,
  // not just that a pass-through stub doesn't interfere.
  refuseBanned: (req, res, next) => (req.user?.is_banned ? res.status(403).json({ banned: true }) : next()),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/users', require('./users'));

test.beforeEach(() => { deleteCalls = []; currentUserBanned = false; });

test('a banned user cannot delete their own account (the re-signup ban-evasion path)', async () => {
  currentUserBanned = true;
  const res = await request(app).delete('/users/me');
  assert.equal(res.status, 403);
  assert.equal(res.body.banned, true);
  assert.equal(deleteCalls.length, 0, 'refused before the row was ever touched');
});

test('a non-banned user can still delete their own account (steady state unaffected)', async () => {
  const res = await request(app).delete('/users/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(deleteCalls[0], ['u1']);
});
