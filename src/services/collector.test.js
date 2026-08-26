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

const { storeListing } = require('./collector');

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
