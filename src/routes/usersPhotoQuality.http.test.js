// HTTP tests for POST /users/me/photo/quality-check — the Claude-vision photo
// SAFETY + quality gate. This route previously had NO coverage; it was added when
// the inline vision call was deduped into services/photoSafety.js, so the
// behaviour that matters is pinned: the verdict is passed through untouched, and
// an unsafe verdict still deletes the Cloudinary asset + nulls users.photo_url.
// DB / auth / Cloudinary / Claude are stubbed via the require cache. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Mutable fixtures ──
let verdict = { safe: true, safety_reason: null, score: 88, summary: 'Clear face.', issues: [], suggestion: null, good_enough: true };
let dbCalls = [];
let deletedFor = [];
let audits = [];
// applyPrimaryPhotoChange (lib/primaryPhoto.js) reads this before writing.
let usersRow = { photo_url: 'https://res.cloudinary.com/x/old.jpg', is_verified: false };

class ModerationRejectedError extends Error {
  constructor(reason) { super(reason); this.name = 'ModerationRejectedError'; this.userError = true; }
}

inject('../db/pool', {
  query: async (sql, params = []) => {
    dbCalls.push({ sql, params });
    if (/SELECT photo_url, is_verified FROM users WHERE id = \$1/.test(sql)) {
      return { rows: [{ ...usersRow }] };
    }
    if (/UPDATE users SET photo_url = \$1/.test(sql)) {
      usersRow = sql.includes('is_verified = FALSE')
        ? { photo_url: params[0], is_verified: false }
        : { ...usersRow, photo_url: params[0] };
    }
    return { rows: [] };
  },
});
inject('../services/photoSafety', { checkPhotoSafety: async () => verdict });
inject('../services/cloudinary', {
  uploadProfilePhoto: async () => ({ url: 'https://res.cloudinary.com/x/u.jpg' }),
  deleteProfilePhoto: async (userId) => { deletedFor.push(userId); },
  ModerationRejectedError,
});
inject('../services/auditLog', { audit: async (_req, event, meta) => { audits.push({ event, meta }); } });
inject('../middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'user-me' }; next(); } });
inject('../middleware/suspiciousActivity', { track: () => (_req, _res, next) => next() });
inject('../services/email', { sendParentInviteEmail: async () => {}, generateOTP: () => '123456', sendOTPEmail: async () => {} });
inject('./sentryTunnel', { reportServerError: () => {} });

const express = require('express');
const request = require('supertest');
const usersRouter = require('./users');

const app = express();
app.use(express.json());
app.use('/users', usersRouter);
let pushCalls = [];
app.set('sendPushToUser', (userId, payload) => { pushCalls.push({ userId, payload }); return Promise.resolve(); });

const URL_OK = 'https://res.cloudinary.com/haveniq/image/upload/v1/haveniq/users/user-me.jpg';
const post = (body) => request(app).post('/users/me/photo/quality-check').send(body);

test.beforeEach(() => {
  dbCalls = []; deletedFor = []; audits = []; pushCalls = [];
  usersRow = { photo_url: 'https://res.cloudinary.com/x/old.jpg', is_verified: false };
  verdict = { safe: true, safety_reason: null, score: 88, summary: 'Clear face.', issues: [], suggestion: null, good_enough: true };
});

// ── Input validation ──
test('400 when url is missing or not a string', async () => {
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ url: 42 })).status, 400);
});

test('400 when the url is not Cloudinary-hosted (no SSRF to arbitrary hosts)', async () => {
  const res = await post({ url: 'https://evil.example.com/x.jpg' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Cloudinary/i);
});

// ── Safe path ──
test('safe verdict: 200, passed through verbatim, no side effects', async () => {
  const res = await post({ url: URL_OK });
  assert.equal(res.status, 200);
  assert.equal(res.body.safe, true);
  assert.equal(res.body.score, 88);
  assert.equal(res.body.good_enough, true);
  assert.deepEqual(deletedFor, [], 'must not delete a safe photo');
  assert.equal(dbCalls.some((c) => c.sql.includes('photo_url = NULL')), false, 'must not null photo_url');
  assert.deepEqual(audits, []);
});

// ── Unsafe path (the reason this route exists) ──
test('unsafe verdict: deletes the asset, nulls photo_url, audits, returns the reason', async () => {
  verdict = { safe: false, safety_reason: 'Not appropriate for a school platform.', score: 10, summary: '', issues: [], suggestion: null, good_enough: false };
  const res = await post({ url: URL_OK });

  assert.equal(res.status, 200);
  assert.equal(res.body.safe, false);
  assert.equal(res.body.safety_reason, 'Not appropriate for a school platform.');
  assert.deepEqual(deletedFor, ['user-me'], 'unsafe photo must be deleted from Cloudinary');
  const nulled = dbCalls.find((c) => /UPDATE users SET photo_url = \$1/.test(c.sql));
  assert.ok(nulled, 'photo_url must be nulled');
  assert.equal(nulled.params[0], null);
  assert.equal(usersRow.photo_url, null);
  assert.equal(audits[0].event, 'photo.rejected.unsafe');
});

test('unsafe verdict while previously verified → nulling the photo also re-queues review', async () => {
  usersRow = { photo_url: 'https://res.cloudinary.com/x/old.jpg', is_verified: true };
  verdict = { safe: false, safety_reason: 'nope', score: 0, summary: '', issues: [], suggestion: null, good_enough: false };
  const res = await post({ url: URL_OK });
  assert.equal(res.status, 200);
  assert.equal(usersRow.is_verified, false, 'a verified account with its only photo just nulled must re-enter review');
  assert.equal(pushCalls.length, 1);
});

test('unsafe verdict: still returns the verdict even if cleanup throws (best-effort)', async () => {
  verdict = { safe: false, safety_reason: 'nope', score: 0, summary: '', issues: [], suggestion: null, good_enough: false };
  const cloud = require.cache[require.resolve('../services/cloudinary')].exports;
  const orig = cloud.deleteProfilePhoto;
  cloud.deleteProfilePhoto = async () => { throw new Error('cloudinary down'); };
  try {
    const res = await post({ url: URL_OK });
    assert.equal(res.status, 200);
    assert.equal(res.body.safe, false, 'verdict still reaches the user');
  } finally { cloud.deleteProfilePhoto = orig; }
});

// ── Soft-fail (Claude unreachable) ──
test('soft-fail verdict from the helper passes through and never blocks the user', async () => {
  verdict = { safe: true, safety_reason: null, score: null, summary: 'Quality check unavailable', issues: [], suggestion: null, good_enough: true };
  const res = await post({ url: URL_OK });
  assert.equal(res.status, 200);
  assert.equal(res.body.safe, true);
  assert.equal(res.body.good_enough, true, 'outage must not block the upload');
  assert.deepEqual(deletedFor, []);
});
