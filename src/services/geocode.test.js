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

const { geocodeListing, geocodeSchool, buildQuery } = require('./geocode');

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

// ── geocodeSchool: the campus, not something named after it ────────────────
//
// This was geocodeOne(school) and it was wrong by 383 miles. "University of
// California, Berkeley" returned a point in IRVINE, because Nominatim reads
// the comma as an address separator and "Berkeley Court Apartments, University
// Town Center, Irvine" is then an excellent match. UCLA returned Cal State LA.
// Nothing caught it: the range checks above reject NaN and off-planet
// coordinates, and a plausible point in the wrong city passes every one — then
// getSchoolCoords caches it with ON CONFLICT DO NOTHING and it sticks forever.
//
// The network is stubbed here, so these pin the two decisions that fix it
// rather than the provider's answers.

test('geocodeSchool strips commas — the official name is not an address', async () => {
  let asked = '';
  stubFetch(async (url) => { asked = decodeURIComponent(String(url)); return ok([{ lat: '37.87', lon: '-122.26', type: 'university' }])(); });
  await geocodeSchool('University of California, Berkeley');
  assert.ok(!asked.includes(','), `query still carries a comma: ${asked}`);
  assert.ok(asked.includes('University of California Berkeley'), asked);
});

test('geocodeSchool takes a campus-typed result over a better-ranked one', async () => {
  // Exactly the Irvine failure: the apartment block ranks first on string
  // similarity, and the university is further down the list.
  stubFetch(ok([
    { lat: '33.649', lon: '-117.836', type: 'residential' },   // Berkeley Court Apartments, Irvine
    { lat: '33.651', lon: '-117.835', type: 'tertiary' },      // Berkeley Avenue, Irvine
    { lat: '37.8719', lon: '-122.2585', type: 'university' },  // the actual campus
  ]));
  assert.deepEqual(await geocodeSchool('University of California, Berkeley'),
    { lat: 37.8719, lon: -122.2585 });
});

test('geocodeSchool accepts college and school types too', async () => {
  stubFetch(ok([
    { lat: '1', lon: '1', type: 'bus_stop' },
    { lat: '33.6712', lon: '-117.9112', type: 'college' },
  ]));
  assert.deepEqual(await geocodeSchool('Orange Coast College'), { lat: 33.6712, lon: -117.9112 });
});

test('geocodeSchool falls back to the first result when nothing is campus-typed', async () => {
  // Better a ranked guess than no coordinates at all — the caller treats a
  // miss as "no distance filtering", which is a worse experience than an
  // approximate campus.
  stubFetch(ok([{ lat: '10', lon: '20', type: 'suburb' }]));
  assert.deepEqual(await geocodeSchool('Somewhere Polytechnic'), { lat: 10, lon: 20 });
});

test('geocodeSchool asks for several candidates, not just the top hit', async () => {
  let asked = '';
  stubFetch(async (url) => { asked = String(url); return ok([{ lat: '1', lon: '2', type: 'university' }])(); });
  await geocodeSchool('UCLA');
  assert.ok(/limit=([2-9]|\d{2,})/.test(asked), `expected limit > 1, got: ${asked}`);
});

test('listing geocoding still takes the first hit, unchanged', async () => {
  // The school fix must not leak into address lookups, where a comma IS
  // meaningful and the top hit is the right answer.
  let asked = '';
  stubFetch(async (url) => { asked = decodeURIComponent(String(url)); return ok([
    { lat: '33.6405', lon: '-117.8443', type: 'house' },
    { lat: '0', lon: '0', type: 'university' },
  ])(); });
  assert.deepEqual(await geocodeListing(ADDR), { lat: 33.6405, lon: -117.8443 });
  assert.ok(asked.includes('412 Bardeen Ave, Irvine'), asked);
});
