// collector — the guarantees that matter if this thing ever misbehaves.
//
// The parser and the robots gate have their own tests. What is checked here is
// the part that decides what reaches a student:
//
//   • a collected listing is NEVER stored as approved
//   • a listing whose risk score says reject is stored rejected, not pending
//   • the insert de-duplicates on source_url, so a re-run is a no-op
//   • a posting with no address and no usable reverse geocode is dropped
//     rather than stored with an invented location
//
// DB and geocoder stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let inserts = [];
let insertReturns = [{ id: 'l-1' }];
inject('../db/pool', {
  query: async (sql, params = []) => {
    inserts.push({ sql, params });
    return { rows: insertReturns };
  },
});

let reverseResult = { address: '412 Bardeen Ave', city: 'Irvine' };
inject('./geocode', {
  reverseGeocode: async () => reverseResult,
  geocodeListing: async () => null,
  geocodeSchool: async () => null,
  haversineMiles: () => null,
});

const { storeListing, implausibleRent: cl_band, secureUrl } = require('./collector');

const PARSED = {
  sourceUrl: 'https://www.craigslist.org/view/d/x/abc',
  title: 'Bright 2BR near campus',
  totalRentCents: 240000,
  beds: 2,
  baths: 1,
  latitude: 34.0969,
  longitude: -118.328,
  postedAt: '2026-08-26T12:09:43-0700',
  notes: 'Two bedroom, laundry in unit.',
  address: '1000 Westwood Blvd',
};
const OPTS = { source: 'craigslist', schoolNear: 'UCLA', city: 'Los Angeles' };

function reset() {
  inserts = [];
  insertReturns = [{ id: 'l-1' }];
  reverseResult = { address: '412 Bardeen Ave', city: 'Irvine' };
}

/**
 * The value bound to a named column.
 *
 * Not a plain column-index lookup: the insert mixes placeholders with SQL
 * literals (`now()` for geocoded_at, `TRUE` for is_active), so the Nth column
 * is not the Nth parameter. Mapping through the actual $n positions is the
 * only way this reads the right value — the naive version silently returned a
 * neighbouring column and made two passing-looking assertions compare the
 * wrong things.
 */
const paramOf = (name) => {
  const { sql, params } = inserts[0];
  const cols = sql.match(/\(([^)]*)\)\s*VALUES/s)[1].split(',').map(s => s.trim());
  const vals = sql.match(/VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/)[1].split(',').map(s => s.trim());
  const i = cols.indexOf(name);
  assert.ok(i >= 0, `no such column: ${name}`);
  const m = vals[i] && vals[i].match(/^\$(\d+)$/);
  assert.ok(m, `${name} is a literal (${vals[i]}), not a bound parameter`);
  return params[Number(m[1]) - 1];
};

test('a clean collected listing is stored PENDING, never approved', async () => {
  // The whole reason the collector is allowed to exist. A clean risk score is
  // not evidence that whoever posted it controls the unit, and no classifier
  // can establish that — so a human looks before a student does.
  reset();
  const out = await storeListing(PARSED, OPTS);
  assert.equal(out.stored, true);
  assert.equal(out.status, 'pending');
  assert.equal(paramOf('moderation_status'), 'pending');
});

test('a listing that trips the fatal scam pair is stored REJECTED', async () => {
  reset();
  const scam = { ...PARSED, notes: 'I am currently out of the country so I cannot show it. Wire transfer only and I will mail the keys.' };
  const out = await storeListing(scam, OPTS);
  assert.equal(out.status, 'rejected');
  assert.ok(out.riskScore >= 70 || paramOf('moderation_status') === 'rejected');
});

test('per-person rent is derived from the bed count, not copied from total', async () => {
  // $2400 for a 2BR is $1200 each. Storing 2400 as per-person would put the
  // listing outside every student's budget filter and hide it entirely.
  reset();
  await storeListing(PARSED, OPTS);
  assert.equal(paramOf('total_rent_cents'), 240000);
  assert.equal(paramOf('per_person_rent_cents'), 120000);
});

test('a room-priced listing is stored as-is, not divided by the bed count', async () => {
  // pricedPerPerson means the source already states what ONE person pays. A
  // $650 room in a 3BR must stay $650; dividing it stored $216, which is not a
  // price any room in Los Angeles is let at and reads as a bargain, not a bug.
  reset();
  await storeListing({ ...PARSED, totalRentCents: 65000, beds: 3, pricedPerPerson: true }, OPTS);
  assert.equal(paramOf('total_rent_cents'), 65000);
  assert.equal(paramOf('per_person_rent_cents'), 65000);
});

test('the insert de-duplicates on source_url so a re-run is a no-op', async () => {
  reset();
  await storeListing(PARSED, OPTS);
  assert.match(inserts[0].sql, /ON CONFLICT \(source_url\)[\s\S]*DO NOTHING/);
});

test('an insert that hits the conflict reports not-stored rather than throwing', async () => {
  reset();
  insertReturns = [];                      // DO NOTHING returns no row
  const out = await storeListing(PARSED, OPTS);
  assert.equal(out.stored, false);
  assert.match(out.reason, /already collected/);
});

test('provenance is recorded, so a collected row is distinguishable forever', async () => {
  reset();
  await storeListing(PARSED, OPTS);
  assert.equal(paramOf('source'), 'craigslist');
  assert.equal(paramOf('source_url'), PARSED.sourceUrl);
  assert.equal(paramOf('school_near'), 'UCLA');
});

test('no mapped address falls back to the coordinates it already has', async () => {
  reset();
  const out = await storeListing({ ...PARSED, address: null }, OPTS);
  assert.equal(out.stored, true);
  assert.equal(paramOf('address'), '412 Bardeen Ave');
});

test('no address and no usable reverse geocode is DROPPED, not invented', async () => {
  // Storing a listing whose location we cannot establish is the one outcome
  // worse than not having the listing.
  reset();
  reverseResult = null;
  const out = await storeListing({ ...PARSED, address: null }, OPTS);
  assert.equal(out.stored, false);
  assert.equal(inserts.length, 0, 'nothing was written');
});

test('coordinates from the posting are stored, so no forward geocode is needed', async () => {
  reset();
  await storeListing(PARSED, OPTS);
  assert.equal(paramOf('latitude'), 34.0969);
  assert.equal(paramOf('longitude'), -118.328);
});

// ── incremental collection ─────────────────────────────────────────────────

test('filterNew drops what we already hold, without fetching it', async () => {
  reset();
  // The query aliases both branches to `url` (listings.source_url and
  // collector_seen.url), so that is the column the stub must return.
  insertReturns = [{ url: 'https://x/b' }];              // the DB says it has b
  const { filterNew } = require('./collector');
  const out = await filterNew(['https://x/a', 'https://x/b', 'https://x/c'], 'craigslist');

  assert.deepEqual(out, ['https://x/a', 'https://x/c']);
  assert.match(inserts[0].sql, /source_url = ANY\(\$2::text\[\]\)/, 'one bulk query, not one per url');
  assert.equal(inserts[0].params[0], 'craigslist', 'scoped to the source');
});

test('filterNew on an empty list does not query at all', async () => {
  reset();
  const { filterNew } = require('./collector');
  assert.deepEqual(await filterNew([], 'craigslist'), []);
  assert.equal(inserts.length, 0);
});

test('filterNew keeps everything when the source is new to us', async () => {
  reset();
  insertReturns = [];
  const { filterNew } = require('./collector');
  const urls = ['https://x/a', 'https://x/b'];
  assert.deepEqual(await filterNew(urls, 'craigslist'), urls);
});

// ── collector memory ───────────────────────────────────────────────────────

test('filterNew also excludes URLs we tried and settled, not just stored ones', async () => {
  // The bug this exists to prevent: an expired posting is never STORED, so
  // listings.source_url alone would let the 410s at the top of a sitemap be
  // re-requested every cycle, and a scheduled run would never reach the live
  // listings behind them. Four of the first five LA postings were already gone.
  reset();
  const { filterNew } = require('./collector');
  await filterNew(['https://x/a'], 'craigslist');
  assert.match(inserts[0].sql, /FROM collector_seen/, 'consults the memory table');
  assert.match(inserts[0].sql, /outcome <> 'failed'/, 'but a transient failure stays retryable');
});

test("remember() records the outcome and never throws", async () => {
  reset();
  const { remember } = require('./collector');
  await remember('craigslist', 'https://x/a', 'expired');
  assert.match(inserts[0].sql, /INSERT INTO collector_seen/);
  assert.deepEqual(inserts[0].params, ['craigslist', 'https://x/a', 'expired']);
  assert.match(inserts[0].sql, /ON CONFLICT \(source, url\) DO UPDATE/);
});

test('a bookkeeping failure never breaks a collection run', async () => {
  // Losing a row here costs one wasted re-fetch next cycle. Throwing would
  // abandon the rest of the run.
  reset();
  const { remember } = require('./collector');
  const pool = require('../db/pool');
  const original = pool.query;
  pool.query = async () => { throw new Error('deadlock detected'); };
  await assert.doesNotReject(() => remember('craigslist', 'https://x/a', 'stored'));
  pool.query = original;
});

test('the photo the adapter found is actually stored', async () => {
  // Every adapter extracted photoUrl and storeListing dropped it: 663 collected
  // listings, 0 with a photo. The moderation queue is unworkable without it.
  reset();
  await storeListing({ ...PARSED, photoUrl: 'https://images.example.com/a.jpg' }, OPTS);
  assert.equal(paramOf('photo_url'), 'https://images.example.com/a.jpg');
});

test('a listing with no photo stores null rather than a placeholder', async () => {
  reset();
  await storeListing({ ...PARSED, photoUrl: null }, OPTS);
  assert.equal(paramOf('photo_url'), null);
});

// ─── Rent has to be a rent ────────────────────────────────────────────────
//
// Craigslist's housing sitemap carries properties FOR SALE, and the
// subcategory filter only fires on pages whose breadcrumb declares a cat=,
// which the canonical /view/d/ URLs do not. A Malibu house at $1,300,000
// arrived as a listing at $1,300,000 a MONTH and scored 15/100 for scam risk,
// because the scorer reads language and nothing about a genuine for-sale
// posting reads as a scam. It simply is not a rental.

test('a sale price is not stored as a monthly rent', async () => {
  reset();
  const out = await storeListing({ ...PARSED, totalRentCents: 130000000, beds: 1 }, OPTS);
  assert.equal(out.stored, false);
  assert.match(out.reason, /sale price/);
});

test('an implausibly low rent is not stored either', async () => {
  // $150/mo is a nightly rate, a deposit, or a typo.
  reset();
  const out = await storeListing({ ...PARSED, totalRentCents: 15000, beds: 1 }, OPTS);
  assert.equal(out.stored, false);
});

test('zero rent is refused rather than published as free', async () => {
  reset();
  assert.equal((await storeListing({ ...PARSED, totalRentCents: 0, beds: 1 }, OPTS)).stored, false);
});

test('the band is wide enough not to be a market opinion', async () => {
  // Its job is to catch a number belonging to a different kind of transaction,
  // not to decide what a student can afford. Deciding that is the filter's job.
  assert.equal(cl_band(50000), null);      // $500 room
  assert.equal(cl_band(120000), null);     // $1,200
  assert.equal(cl_band(450000), null);     // $4,500 — expensive, still a rent
  assert.equal(cl_band(999900), null);     // just under the ceiling
  assert.ok(cl_band(1000100));             // just over
  assert.ok(cl_band(19900));               // just under the floor
});

test('an ordinary listing still stores', async () => {
  reset();
  assert.equal((await storeListing(PARSED, OPTS)).stored, true);
});

test('a photo url is stored over https, never http', async () => {
  // The app is served over https, so an http image is mixed content — silently
  // upgraded by some browsers, blocked outright by others. A card whose photo
  // is the main thing a student looks at should not depend on which.
  reset();
  await storeListing({ ...PARSED, photoUrl: 'http://uloop.s3.amazonaws.com/a.jpg' }, OPTS);
  assert.equal(paramOf('photo_url'), 'https://uloop.s3.amazonaws.com/a.jpg');
});

test('an https url and a missing one are both left alone', async () => {
  assert.equal(secureUrl('https://x/a.jpg'), 'https://x/a.jpg');
  assert.equal(secureUrl(null), null);
  assert.equal(secureUrl(undefined), undefined);
  // Only the scheme is touched — "http://" inside a path is not a scheme.
  assert.equal(secureUrl('https://x/r?u=http://y'), 'https://x/r?u=http://y');
});

test('a null bath count reaches the database as null', async () => {
  reset();
  await storeListing({ ...PARSED, baths: null }, OPTS);
  assert.equal(paramOf('baths'), null);
});

test('a reverse-geocoded road is stored as "near", not as an address', async () => {
  // 13 approved listings claimed to be AT "Ronald Reagan Freeway" and "Metro G
  // Line Busway". Nobody lives at a freeway. The coordinates are still good,
  // so the true statement is that the place is near that road.
  reset();
  reverseResult = { address: 'Roscoe Boulevard', city: 'Los Angeles' };
  await storeListing({ ...PARSED, address: null }, OPTS);
  assert.equal(paramOf('address'), 'near Roscoe Boulevard');
});

test('a reverse-geocoded street NUMBER is kept as an address', async () => {
  reset();
  reverseResult = { address: '412 Bardeen Ave', city: 'Los Angeles' };
  await storeListing({ ...PARSED, address: null }, OPTS);
  assert.equal(paramOf('address'), '412 Bardeen Ave');
});

test('the top of a range is stored, so a from-price can be labelled as one', async () => {
  reset();
  await storeListing({ ...PARSED, totalRentCents: 62500, highRentCents: 70000 }, OPTS);
  assert.equal(paramOf('total_rent_cents'), 62500);
  assert.equal(paramOf('high_rent_cents'), 70000);
});

test('a single price stores no range rather than repeating itself', async () => {
  // high === total is not a range, and storing it as one would put "from" on a
  // price that is simply the price.
  reset();
  await storeListing({ ...PARSED, totalRentCents: 62500, highRentCents: 62500 }, OPTS);
  assert.equal(paramOf('high_rent_cents'), null);
  reset();
  await storeListing({ ...PARSED, totalRentCents: 62500 }, OPTS);
  assert.equal(paramOf('high_rent_cents'), null);
});

test('an availability date reaches the database', async () => {
  reset();
  await storeListing({ ...PARSED, availableFrom: '2026-09-01' }, OPTS);
  assert.equal(paramOf('available_from'), '2026-09-01');
});

test('a posting that never said gets null, not today', async () => {
  reset();
  await storeListing({ ...PARSED, availableFrom: null }, OPTS);
  assert.equal(paramOf('available_from'), null);
});

test('the whole gallery is stored, over https', async () => {
  reset();
  await storeListing({ ...PARSED, photoUrls: ['http://a/1.jpg', 'https://a/2.jpg'] }, OPTS);
  assert.deepEqual(paramOf('photo_urls'), ['https://a/1.jpg', 'https://a/2.jpg']);
});

test('no photos stores null, not an empty array', async () => {
  // A column that is sometimes [] and sometimes NULL makes every reader handle
  // two shapes for one fact.
  reset();
  await storeListing({ ...PARSED, photoUrls: [] }, OPTS);
  assert.equal(paramOf('photo_urls'), null);
});
