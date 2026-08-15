// PATCH /users/me — the photo_url moderation-bypass fix + re-verification.
//
// Before this fix, photo_url's validator accepted ANY http(s) URL under 500
// chars. Every OTHER photo path (POST /users/me/photo, the gallery upload,
// even the quality-check route) requires Cloudinary hosting — which is what
// actually runs the photo through Cloudinary's AI moderation + the
// checkPhotoSafety Claude-vision gate. A raw PATCH /users/me with an
// arbitrary external photoUrl bypassed ALL of that, and — separately — never
// touched is_verified, so a verified account could swap to a completely
// unreviewed (or outright unsafe) photo and keep the badge forever.
//
// This locks: (1) a non-Cloudinary photoUrl is rejected, (2) a real
// Cloudinary-hosted photoUrl change resets is_verified when previously
// verified, (3) an unchanged photoUrl (re-saving the same URL) does nothing,
// (4) other fields in the same PATCH are unaffected either way.
// auth/pool stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let usersRow = { photo_url: null, is_verified: false };
let updateCalls = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT photo_url, is_verified FROM users WHERE id = \$1/.test(sql)) {
      return { rows: [{ ...usersRow }] };
    }
    if (/UPDATE users SET/.test(sql)) {
      updateCalls.push({ sql, params });
      if (/photo_url = \$(\d+)/.test(sql)) {
        const idx = sql.match(/photo_url = \$(\d+)/)[1] - 1;
        usersRow.photo_url = params[idx];
      }
      if (sql.includes('is_verified = FALSE')) usersRow.is_verified = false;
      return { rows: [{ id: 'u1', ...usersRow }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
});
let currentUserBanned = false;
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'u1', email: 'a@ohio.edu', school: 'Ohio University', is_banned: currentUserBanned }; next(); },
  // Real conditional — proves PATCH /me actually stacks this middleware.
  refuseBanned: (req, res, next) => (req.user?.is_banned ? res.status(403).json({ banned: true }) : next()),
});

let pushCalls = [];

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/users', require('./users'));
app.set('sendPushToUser', (userId, payload) => { pushCalls.push({ userId, payload }); return Promise.resolve(); });

const patch = (body) => request(app).patch('/users/me').send(body);

test.beforeEach(() => {
  usersRow = { photo_url: null, is_verified: false };
  updateCalls = [];
  pushCalls = [];
  currentUserBanned = false;
});

const CLOUDINARY_URL = 'https://res.cloudinary.com/haveniq/image/upload/v1/users/u1/photo.jpg';

test('a banned user is refused on PATCH /me entirely', async () => {
  currentUserBanned = true;
  const res = await patch({ bio: 'trying to sneak an edit in' });
  assert.equal(res.status, 403);
  assert.equal(res.body.banned, true);
  assert.equal(updateCalls.length, 0, 'refused before touching the DB at all');
});

test('a non-Cloudinary photoUrl is rejected (the moderation bypass this closes)', async () => {
  const res = await patch({ photoUrl: 'https://evil.example.com/whatever.jpg' });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /photoUrl/);
  assert.equal(usersRow.photo_url, null, 'nothing was written');
});

test('a Cloudinary photoUrl while previously verified → resets is_verified + notifies', async () => {
  usersRow = { photo_url: null, is_verified: true };
  const res = await patch({ photoUrl: CLOUDINARY_URL });
  assert.equal(res.status, 200);
  assert.equal(res.body.reverified, true);
  assert.equal(res.body.user.isVerified === undefined ? usersRow.is_verified : res.body.user.isVerified, false);
  assert.equal(pushCalls.length, 1);
  assert.match(pushCalls[0].payload.body, /re-checking your account/);
});

test('a Cloudinary photoUrl while NOT verified → no reset, no push', async () => {
  usersRow = { photo_url: null, is_verified: false };
  const res = await patch({ photoUrl: CLOUDINARY_URL });
  assert.equal(res.status, 200);
  assert.equal(res.body.reverified, false);
  assert.equal(pushCalls.length, 0);
});

test('re-saving the SAME photoUrl (no real change) never re-verifies, even if verified', async () => {
  usersRow = { photo_url: CLOUDINARY_URL, is_verified: true };
  const res = await patch({ photoUrl: CLOUDINARY_URL });
  assert.equal(res.status, 200);
  assert.equal(res.body.reverified, false);
  assert.equal(usersRow.is_verified, true);
  assert.equal(pushCalls.length, 0);
});

test('other fields in the same PATCH still save when photoUrl also resets verification', async () => {
  usersRow = { photo_url: null, is_verified: true };
  const res = await patch({ photoUrl: CLOUDINARY_URL, bio: 'hello there' });
  assert.equal(res.status, 200);
  assert.equal(res.body.reverified, true);
  const call = updateCalls[0];
  assert.match(call.sql, /bio = \$/);
  assert.match(call.sql, /photo_url = \$/);
  assert.match(call.sql, /is_verified = FALSE/);
});

test('a PATCH with no photoUrl never touches is_verified', async () => {
  usersRow = { photo_url: CLOUDINARY_URL, is_verified: true };
  const res = await patch({ bio: 'just a bio update' });
  assert.equal(res.status, 200);
  assert.equal(res.body.reverified, false);
  assert.equal(usersRow.is_verified, true);
  const call = updateCalls[0];
  assert.doesNotMatch(call.sql, /is_verified/);
});
