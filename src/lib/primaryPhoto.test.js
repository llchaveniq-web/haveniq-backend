const test = require('node:test');
const assert = require('node:assert');
const { applyPrimaryPhotoChange } = require('./primaryPhoto');

function fakePool(initial) {
  let row = { ...initial };
  const calls = [];
  return {
    calls,
    row: () => row,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT photo_url, is_verified FROM users WHERE id = \$1/.test(sql)) {
        return { rows: [{ ...row }] };
      }
      if (/UPDATE users SET photo_url = \$1/.test(sql)) {
        row = sql.includes('is_verified = FALSE')
          ? { photo_url: params[0], is_verified: false }
          : { ...row, photo_url: params[0] };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test('unknown user → no-op, no write', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const res = await applyPrimaryPhotoChange(pool, 'ghost', 'https://x/y.jpg');
  assert.deepEqual(res, { changed: false, reverified: false });
});

test('same URL → no-op (null vs null counts as unchanged too)', async () => {
  const pool = fakePool({ photo_url: null, is_verified: true });
  const res = await applyPrimaryPhotoChange(pool, 'u1', null);
  assert.deepEqual(res, { changed: false, reverified: false });
  assert.equal(pool.row().is_verified, true, 'untouched — no UPDATE fired at all');
});

test('real change while verified → resets is_verified, reverified:true', async () => {
  const pool = fakePool({ photo_url: 'old.jpg', is_verified: true });
  const res = await applyPrimaryPhotoChange(pool, 'u1', 'new.jpg');
  assert.deepEqual(res, { changed: true, reverified: true });
  assert.equal(pool.row().photo_url, 'new.jpg');
  assert.equal(pool.row().is_verified, false);
});

test('real change while NOT verified → plain update, reverified:false', async () => {
  const pool = fakePool({ photo_url: 'old.jpg', is_verified: false });
  const res = await applyPrimaryPhotoChange(pool, 'u1', 'new.jpg');
  assert.deepEqual(res, { changed: true, reverified: false });
  assert.equal(pool.row().photo_url, 'new.jpg');
  assert.equal(pool.row().is_verified, false);
});

test('change to null (photo removed) while verified → still resets', async () => {
  const pool = fakePool({ photo_url: 'old.jpg', is_verified: true });
  const res = await applyPrimaryPhotoChange(pool, 'u1', null);
  assert.deepEqual(res, { changed: true, reverified: true });
  assert.equal(pool.row().photo_url, null);
  assert.equal(pool.row().is_verified, false);
});
