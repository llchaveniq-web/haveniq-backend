// Pre-match photo gallery (owner decision 2026-07-22: faces visible while
// CHOOSING a match, not only after one).
//
// The shaping is small but it runs on every candidate in every feed, so the
// cases that matter are: the 4-cap holds, the single-photo fallback works, and
// an empty gallery yields [] rather than anything invented. node --test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { galleryJoin, photosFor, MAX_FEED_PHOTOS } = require('./photoGallery');

test('the feed cap is 4 — matching the app\'s REVEAL_PHOTO_COUNT', () => {
  assert.equal(MAX_FEED_PHOTOS, 4);
});

test('an ordered gallery passes through in order', () => {
  assert.deepEqual(photosFor({ photo_urls: ['a.jpg', 'b.jpg', 'c.jpg'] }), ['a.jpg', 'b.jpg', 'c.jpg']);
});

test('more than 4 stored photos are capped at 4', () => {
  // Storage allows 6; a user who uploaded 6 must not ship two extra images to
  // every viewer in the deck.
  const out = photosFor({ photo_urls: ['1', '2', '3', '4', '5', '6'] });
  assert.equal(out.length, 4);
  assert.deepEqual(out, ['1', '2', '3', '4']);
});

test('no gallery falls back to the single photo_url', () => {
  assert.deepEqual(photosFor({ photo_urls: null, photo_url: 'only.jpg' }), ['only.jpg']);
  assert.deepEqual(photosFor({ photo_url: 'only.jpg' }), ['only.jpg']);
});

test('a gallery WINS over photo_url (it is the ordered, owner-chosen set)', () => {
  assert.deepEqual(photosFor({ photo_urls: ['g1', 'g2'], photo_url: 'legacy.jpg' }), ['g1', 'g2']);
});

test('no photos at all ⇒ [] — never a placeholder, never invented', () => {
  assert.deepEqual(photosFor({ photo_urls: null, photo_url: null }), []);
  assert.deepEqual(photosFor({}), []);
  assert.deepEqual(photosFor({ photo_urls: [], photo_url: '' }), []);
  assert.deepEqual(photosFor({ photo_urls: [null, undefined] }), []);
});

test('a blank/whitespace photo_url is not treated as a photo', () => {
  assert.deepEqual(photosFor({ photo_url: '   ' }), []);
});

// ── SQL shape ──
test('the join is ordered, capped, and skips blank urls', () => {
  const sql = galleryJoin('u.id', 'ph');
  assert.match(sql, /ORDER BY p\.position/,  'gallery order is the owner-set order');
  assert.match(sql, /ORDER BY position ASC/, 'inner select ordered before LIMIT');
  assert.match(sql, new RegExp(`LIMIT ${MAX_FEED_PHOTOS}`));
  assert.match(sql, /btrim\(url\) <> ''/,    'blank rows must not become empty images');
  assert.match(sql, /LEFT JOIN LATERAL/,     'LEFT so a user with no photos still appears');
});

test('the join is LEFT — a candidate with no photos is never dropped from the feed', () => {
  // An INNER join here would silently remove every photo-less student from
  // discovery, which is the "gating discovery on completeness hid real people"
  // failure this codebase already hit once.
  assert.ok(!/\bINNER JOIN LATERAL/.test(galleryJoin()));
});

// ── Every pre-match surface actually ships it ──
test('feed, daily pick, search and profile all return `photos`', () => {
  const root = path.join(__dirname, '..', 'routes');
  const surfaces = {
    'matches.js':       'the deck / fit report',
    'matchOfTheDay.js': 'daily pick',
    'search.js':        'search',
    'users.js':         'single profile',
  };
  for (const [file, label] of Object.entries(surfaces)) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(/photosFor\(/.test(src), `${label} (${file}) must shape a photos array`);
    assert.ok(/galleryJoin\(/.test(src), `${label} (${file}) must join the gallery`);
  }
});

test('no surface leaks the raw photo_urls aggregate to the client', () => {
  // `photo_urls` is the internal column name; the documented field is `photos`.
  const root = path.join(__dirname, '..', 'routes');
  const leaks = [];
  for (const f of ['matches.js', 'matchOfTheDay.js', 'search.js', 'users.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const line of src.split('\n')) {
      // A response-object key literally named photo_urls / photoUrls.
      if (/^\s*photo_?[Uu]rls\s*:/.test(line)) leaks.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(leaks, [], 'expose `photos`, not the raw aggregate');
});
