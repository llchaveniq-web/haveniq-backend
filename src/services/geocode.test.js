// geocode — address to coordinates, via Nominatim.
//
// The network call is stubbed. What's actually worth testing is the REJECTION
// logic, because it's the only thing standing between a malformed provider
// response and a coordinate stored in the listings table. A NaN or an
// out-of-range pair is accepted happily by Postgres and then puts a student in
// the ocean, with nothing failing anywhere along the way.
//
// Everything here must return null rather than throw: the caller runs detached
// from a listing insert, and a geocoder outage has to degrade the map pin, not
// break listing creation.
const test = require('node:test');
const assert = require('node:assert');

const { geocodeListing, buildQuery } = require('./geocode');

const realFetch = global.fetch;
function stubFetch(impl) { global.fetch = impl; }
test.afterEach(() => { global.fetch = realFetch; });

const ok = (body) => async () => ({ ok: true, json: async () => body });

const ADDR = { address: '412 Bardeen Ave', city: 'Irvine', schoolNear: 'UC Irvine' };

test('returns coordinates from a well-formed response', async () => {
  stubFetch(ok([{ lat: '33.6405', lon: '-117.8443' }]));
  assert.deepEqual(await geocodeListing(ADDR), { lat: 33.6405, lon: -117.8443 });
});

test('returns null without an address rather than geocoding the school', async () => {
  // Same rule the app's mapSearchUrl follows: a pin on a bare school name is a
  // confident wrong answer, which is worse than no answer.
  let called = false;
  stubFetch(async () => { called = true; return ok([])(); });
  assert.equal(await geocodeListing({ city: 'Irvine', schoolNear: 'UC Irvine' }), null);
  assert.equal(await geocodeListing({ address: '   ' }), null);
  assert.equal(called, false, 'should not even call the provider');
});

test('returns null on an empty result set', async () => {
  stubFetch(ok([]));
  assert.equal(await geocodeListing(ADDR), null);
});

test('returns null on a non-OK response', async () => {
  stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  assert.equal(await geocodeListing(ADDR), null);
});

test('returns null when the provider throws or times out', async () => {
  stubFetch(async () => { throw new Error('ETIMEDOUT'); });
  assert.equal(await geocodeListing(ADDR), null);
});

test('rejects unparseable coordinates instead of storing NaN', async () => {
  stubFetch(ok([{ lat: 'not-a-number', lon: '-117.8' }]));
  assert.equal(await geocodeListing(ADDR), null);
});

test('rejects out-of-range coordinates', async () => {
  // 0,0 is valid (Null Island) and NOT rejected — that's a real coordinate and
  // rejecting it would be guessing. Only genuinely impossible values are cut.
  stubFetch(ok([{ lat: '91', lon: '0' }]));
  assert.equal(await geocodeListing(ADDR), null, 'latitude > 90');

  stubFetch(ok([{ lat: '0', lon: '181' }]));
  assert.equal(await geocodeListing(ADDR), null, 'longitude > 180');

  stubFetch(ok([{ lat: '0', lon: '0' }]));
  assert.deepEqual(await geocodeListing(ADDR), { lat: 0, lon: 0 }, '0,0 is valid');
});

test('returns null on a malformed body shape', async () => {
  stubFetch(ok({ results: [] }));
  assert.equal(await geocodeListing(ADDR), null);
});

test('identifies itself, as the provider asks', async () => {
  // Nominatim is free and asks for an identifying User-Agent. Sending none is
  // how a free dependency quietly stops working one day.
  let headers = null;
  stubFetch(async (url, opts) => { headers = opts.headers; return ok([{ lat: '1', lon: '2' }])(); });
  await geocodeListing(ADDR);
  assert.match(headers['User-Agent'], /HavenIQ/);
});

test('buildQuery disambiguates with city and school, skipping blanks', () => {
  assert.equal(buildQuery(ADDR), '412 Bardeen Ave, Irvine, UC Irvine');
  assert.equal(buildQuery({ address: '9 Plow Point Ln', schoolNear: 'UCLA' }), '9 Plow Point Ln, UCLA');
  assert.equal(buildQuery({ address: '1262 Santa Fe', city: '  ' }), '1262 Santa Fe');
});

test('haversineMiles matches a known distance', () => {
  const { haversineMiles } = require('./geocode');
  // Two points ~0.104 deg of longitude apart at latitude 33.6 — about 6 mi.
  const d = haversineMiles({ lat: 33.6405, lon: -117.8443 }, { lat: 33.6500, lon: -117.7400 });
  assert.ok(d > 5.8 && d < 6.3, `expected ~6.0 mi, got ${d}`);
});

test('haversineMiles is zero for the same point, and symmetric', () => {
  const { haversineMiles } = require('./geocode');
  const a = { lat: 33.6405, lon: -117.8443 };
  const b = { lat: 34.0689, lon: -118.4452 };
  assert.equal(haversineMiles(a, a), 0);
  assert.ok(Math.abs(haversineMiles(a, b) - haversineMiles(b, a)) < 1e-9);
});

test('haversineMiles returns null when either end is unknown', () => {
  // A listing with no coordinates has no distance — it must not silently
  // become 0, which would sort it to the top as "closest".
  const { haversineMiles } = require('./geocode');
  assert.equal(haversineMiles(null, { lat: 1, lon: 2 }), null);
  assert.equal(haversineMiles({ lat: 1, lon: 2 }, null), null);
});

test('geocodeSchool refuses an empty name instead of querying for ""', () => {
  const { geocodeSchool } = require('./geocode');
  return Promise.all([
    geocodeSchool('').then(r => assert.equal(r, null)),
    geocodeSchool('   ').then(r => assert.equal(r, null)),
    geocodeSchool(null).then(r => assert.equal(r, null)),
  ]);
});
