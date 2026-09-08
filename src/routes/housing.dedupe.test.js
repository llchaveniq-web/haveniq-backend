// GET /housing/listings must return one row per real place.
//
// Craigslist reposts the same flat every few days under a different three
// amenities, and each repost is a legitimately distinct post: its own URL, its
// own id, its own photos. Nothing upstream is wrong, so nothing upstream can
// fix it. Measured on the live table: 48,060 rows passing the route's filters
// resolve to 20,651 places — 57% of the inventory is repeats, one address
// appearing 162 times. A student scrolling "393 listings" was seeing the same
// handful of buildings over and over.
//
// This pins the SQL the route builds, because the failure is silent: drop the
// DISTINCT ON and everything still returns 200 with plausible-looking rows.
//
// The properties that cannot be asserted against a stub — that no place is
// LOST, and that the page fills with more distinct places — were measured
// against the live table instead: at LIMIT 500, 416 distinct places became
// 500, with zero places present before and missing after.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.JWT_SECRET = 'x'.repeat(48);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/none';

let seen = [];
inject('../db/pool', {
  query: async (sql) => {
    seen.push(sql);
    if (/FROM users WHERE id/i.test(sql)) return { rows: [{ school: null }] };
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
});

function loadRouter() {
  delete require.cache[require.resolve('./housing')];
  return require('./housing');
}

async function callListings() {
  seen = [];
  const router = loadRouter();
  const layer = router.stack.find(l => l.route && l.route.path === '/listings'
    && l.route.methods.get);
  assert.ok(layer, 'GET /listings should be registered');
  const handlers = layer.route.stack.map(s => s.handle);
  const req = { user: { id: 'u1' }, query: {} };
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  // Walk the chain (requireAuth stub, then the handler).
  for (const h of handlers) await new Promise((r) => { const n = () => r(); const out = h(req, res, n); Promise.resolve(out).then(() => r()); });
  return seen.find(s => /FROM listings/i.test(s)) || '';
}

test('the listings query returns one row per address+rent+beds+baths', async () => {
  process.env.HOUSING_DEDUPE = 'on';
  const sql = await callListings();
  assert.match(sql, /DISTINCT ON \(/, 'should de-duplicate:\n' + sql);
  assert.match(sql, /lower\(trim\(address\)\)/);
  assert.match(sql, /coalesce\(per_person_rent_cents,-1\)/);
  assert.match(sql, /coalesce\(beds,-1\)/);
  // Baths is in the key on purpose: it separates only 215 more rows, but 213
  // groups genuinely disagree on bath count and those are different units.
  assert.match(sql, /coalesce\(baths,-1\)/);
});

test('the row kept is one with photos, then the most recent', async () => {
  process.env.HOUSING_DEDUPE = 'on';
  const sql = await callListings();
  assert.match(sql, /array_length\(photo_urls,1\),0\) > 0\) DESC/,
    'a place whose newest repost has no photos should still show a card with one');
  assert.match(sql, /source_posted_at DESC NULLS LAST/);
});

test('ordering follows the group, not the row kept', async () => {
  // Preferring a photo-carrying row can select an OLDER post. Ordering the
  // page by that row's own created_at then pushes the place down and, at a
  // LIMIT, out. Measured: 30 places disappeared before this was added.
  process.env.HOUSING_DEDUPE = 'on';
  const sql = await callListings();
  assert.match(sql, /max\(created_at\) OVER \(PARTITION BY/);
  assert.match(sql, /ORDER BY group_created_at DESC/);
});

test('HOUSING_DEDUPE=off restores the previous behaviour without a deploy', async () => {
  process.env.HOUSING_DEDUPE = 'off';
  const sql = await callListings();
  assert.doesNotMatch(sql, /DISTINCT ON/, 'the switch must actually switch it off');
  assert.doesNotMatch(sql, /group_created_at/);
  assert.match(sql, /ORDER BY created_at DESC/);
  process.env.HOUSING_DEDUPE = 'on';
});

test('the moderation and rent-ceiling guards survive de-duplication', async () => {
  process.env.HOUSING_DEDUPE = 'on';
  const sql = await callListings();
  assert.match(sql, /moderation_status = 'approved'/, 'the "no fake listings" line');
  assert.match(sql, /per_person_rent_cents <= 600000/, 'the student rent ceiling');
  assert.match(sql, /is_active = TRUE/);
});
