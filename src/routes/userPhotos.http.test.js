// HTTP-level tests for the multi-photo gallery (user_photos). DB + auth +
// Cloudinary + the Claude-vision safety check are stubbed via the require cache,
// so these run with no database, Cloudinary account, or Anthropic key. They
// verify the CONTRACT: visibility gate, the 6-photo cap, the unsafe→delete+422
// path, position packing on delete, and reorder validation. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Mutable fixtures ──
let photos = [];            // the current user's gallery rows
let connected = false;      // areConnected() result
let idSeq = 0;
let dbCalls = [];
const find = (frag) => dbCalls.find((c) => c.sql.includes(frag));
const sorted = () => [...photos].sort((a, b) => a.position - b.position);

const fakePool = {
  query: async (sql, params = []) => {
    dbCalls.push({ sql, params });

    if (sql.includes('FROM connect_requests')) return { rows: connected ? [{ x: 1 }] : [] };

    if (sql.includes('SELECT id, url, position FROM user_photos')) {
      return { rows: sorted().map(({ id, url, position }) => ({ id, url, position })) };
    }
    if (sql.includes('SELECT COUNT(*)::int AS n FROM user_photos')) {
      return { rows: [{ n: photos.length }] };
    }
    if (sql.startsWith('\n       INSERT INTO user_photos') || sql.includes('INSERT INTO user_photos')) {
      const [, url, publicId, max] = params;
      if (photos.length >= max) return { rows: [] };            // HAVING COUNT(*) < max failed
      const position = photos.reduce((m, p) => Math.max(m, p.position), -1) + 1;
      const row = { id: `p${++idSeq}`, url, public_id: publicId, position };
      photos.push(row);
      return { rows: [{ id: row.id, url: row.url, position: row.position }] };
    }
    if (sql.includes('SELECT url FROM user_photos')) {          // syncPrimaryPhoto read
      const top = sorted()[0];
      return { rows: top ? [{ url: top.url }] : [] };
    }
    if (sql.startsWith('UPDATE users SET photo_url')) return { rows: [] };
    if (sql.includes('SELECT public_id, position FROM user_photos')) {
      const p = photos.find((x) => x.id === params[0]);
      return { rows: p ? [{ public_id: p.public_id, position: p.position }] : [] };
    }
    if (sql.startsWith('DELETE FROM user_photos')) {
      photos = photos.filter((x) => x.id !== params[0]);
      return { rows: [] };
    }
    if (sql.includes('SET position = position - 1')) {
      photos.forEach((p) => { if (p.position > params[1]) p.position -= 1; });
      return { rows: [] };
    }
    if (sql.includes('SELECT id FROM user_photos')) {
      return { rows: photos.map(({ id }) => ({ id })) };
    }
    if (sql.startsWith('UPDATE user_photos SET position = $1')) {
      const p = photos.find((x) => x.id === params[1]);
      if (p) p.position = params[0];
      return { rows: [] };
    }
    return { rows: [] };
  },
};

// ── Fake Cloudinary + safety ──
class ModerationRejectedError extends Error {
  constructor(reason) { super(reason); this.name = 'ModerationRejectedError'; this.userError = true; }
}
let uploadCalls = 0, deleted = [];
let uploadImpl = async (userId) => ({ url: 'https://res.cloudinary.com/x/gallery/new.jpg', publicId: `haveniq/users/${userId}/gallery/new` });
let safeVerdict = { safe: true };

inject('../db/pool', fakePool);
inject('../services/cloudinary', {
  uploadUserGalleryPhoto: async (userId, buf) => { uploadCalls++; return uploadImpl(userId, buf); },
  deleteByPublicId: async (pid) => { deleted.push(pid); },
  ModerationRejectedError,
});
inject('../services/photoSafety', { checkPhotoSafety: async () => safeVerdict });
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: req.headers['x-test-uid'] || 'user-me' }; next(); },
});
inject('../services/auditLog', { audit: async () => {} });

const express = require('express');
const request = require('supertest');
const photosRouter = require('./userPhotos');

const app = express();
app.use(express.json());
app.use('/users', photosRouter);

test.beforeEach(() => {
  photos = []; connected = false; idSeq = 0; dbCalls = [];
  uploadCalls = 0; deleted = [];
  uploadImpl = async (userId) => ({ url: 'https://res.cloudinary.com/x/gallery/new.jpg', publicId: `haveniq/users/${userId}/gallery/new` });
  safeVerdict = { safe: true };
});

const seed = (n) => { photos = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, url: `u${i}`, public_id: `pid${i}`, position: i })); };

// ── GET /users/:id/photos ──
test('GET: owner sees own photos, ordered by position', async () => {
  photos = [{ id: 'b', url: 'ub', public_id: 'x', position: 1 }, { id: 'a', url: 'ua', public_id: 'x', position: 0 }];
  const res = await request(app).get('/users/user-me/photos');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((p) => p.id), ['a', 'b']);
});

test('GET: a connected match is allowed', async () => {
  connected = true;
  const res = await request(app).get('/users/other-user/photos').set('x-test-uid', 'user-me');
  assert.equal(res.status, 200);
});

test('GET: a stranger (not self, not connected) is 403', async () => {
  connected = false;
  const res = await request(app).get('/users/other-user/photos').set('x-test-uid', 'user-me');
  assert.equal(res.status, 403);
});

// ── POST /users/me/photos ──
test('POST: no file → 400', async () => {
  const res = await request(app).post('/users/me/photos');
  assert.equal(res.status, 400);
});

test('POST: first photo → inserted at position 0 and photo_url synced', async () => {
  const res = await request(app).post('/users/me/photos').attach('photo', Buffer.from('img'), 'a.jpg');
  assert.equal(res.status, 200);
  assert.equal(res.body.position, 0);
  assert.equal(res.body.url, 'https://res.cloudinary.com/x/gallery/new.jpg');
  const sync = find('UPDATE users SET photo_url');
  assert.ok(sync, 'photo_url synced');
  assert.equal(sync.params[0], 'https://res.cloudinary.com/x/gallery/new.jpg');
});

test('POST: a 2nd photo lands at position 1 and does NOT touch photo_url', async () => {
  seed(1);
  const res = await request(app).post('/users/me/photos').attach('photo', Buffer.from('img'), 'a.jpg');
  assert.equal(res.status, 200);
  assert.equal(res.body.position, 1);
  assert.ok(!find('UPDATE users SET photo_url'), 'non-primary insert leaves photo_url alone');
});

test('POST: already at 6 → 409 and NO upload attempted', async () => {
  seed(6);
  const res = await request(app).post('/users/me/photos').attach('photo', Buffer.from('img'), 'a.jpg');
  assert.equal(res.status, 409);
  assert.equal(uploadCalls, 0, 'must not burn a Cloudinary upload when already full');
});

test('POST: unsafe verdict → delete the asset + 422, nothing inserted', async () => {
  safeVerdict = { safe: false, safety_reason: 'nope' };
  const res = await request(app).post('/users/me/photos').attach('photo', Buffer.from('img'), 'a.jpg');
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'nope');
  assert.equal(deleted.length, 1, 'unsafe upload is deleted from Cloudinary');
  assert.equal(photos.length, 0, 'no row inserted');
});

test('POST: Cloudinary moderation rejection → 400 with the reason', async () => {
  uploadImpl = async () => { throw new ModerationRejectedError('Photo blocked (Explicit Nudity).'); };
  const res = await request(app).post('/users/me/photos').attach('photo', Buffer.from('img'), 'a.jpg');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Explicit Nudity/);
});

// ── DELETE /users/me/photos/:photoId ──
test('DELETE: unknown photo → 404', async () => {
  const res = await request(app).delete('/users/me/photos/nope');
  assert.equal(res.status, 404);
});

test('DELETE: removes row, re-packs positions, deletes asset, re-syncs', async () => {
  seed(3);                                   // p0@0, p1@1, p2@2
  const res = await request(app).delete('/users/me/photos/p0');
  assert.equal(res.status, 200);
  assert.deepEqual(sorted().map((p) => p.id), ['p1', 'p2']);
  assert.deepEqual(sorted().map((p) => p.position), [0, 1], 'positions re-packed contiguous');
  assert.ok(deleted.includes('pid0'), 'Cloudinary asset deleted by public_id');
  const sync = find('UPDATE users SET photo_url');
  assert.equal(sync.params[0], 'u1', 'photo_url re-synced to new position-0');
});

// ── PATCH /users/me/photos/reorder ──
test('PATCH reorder: rejects an order that is not exactly the user\'s photos', async () => {
  seed(3);
  assert.equal((await request(app).patch('/users/me/photos/reorder').send({ order: ['p0', 'p1'] })).status, 400);       // missing one
  assert.equal((await request(app).patch('/users/me/photos/reorder').send({ order: ['p0', 'p1', 'x'] })).status, 400);  // foreign id
  assert.equal((await request(app).patch('/users/me/photos/reorder').send({ order: ['p0', 'p0', 'p1'] })).status, 400); // dupe
  assert.equal((await request(app).patch('/users/me/photos/reorder').send({ order: [] })).status, 400);                 // empty
});

test('PATCH reorder: rewrites positions and syncs photo_url to the new first', async () => {
  seed(3);                                   // p0,p1,p2
  const res = await request(app).patch('/users/me/photos/reorder').send({ order: ['p2', 'p0', 'p1'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((p) => p.id), ['p2', 'p0', 'p1']);
  assert.deepEqual(res.body.map((p) => p.position), [0, 1, 2]);
  const sync = find('UPDATE users SET photo_url');
  assert.equal(sync.params[0], 'u2', 'photo_url = new position-0 url');
});
