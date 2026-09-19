// getSchoolCoords decides whether a student's Housing tab searches by distance
// from their campus or falls back to a label almost no listing carries. A
// FAILED lookup used to be cached as "no such campus" forever. pool and the
// geocoder stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let row = null;          // what school_coords holds for the school
let writes = [];
let geo = async () => null;
class GeocodeUnavailable extends Error {}

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT latitude, longitude, attempted_at FROM school_coords/.test(sql)) return { rows: row ? [row] : [] };
    if (/INSERT INTO school_coords/.test(sql)) { writes.push(params); return { rows: [] }; }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (_q, _s, n) => n(), optionalAuth: (_q, _s, n) => n(), refuseBanned: (_q, _s, n) => n(),
  requireFounder: (_q, _s, n) => n(),
});
inject('../services/geocode', {
  GeocodeUnavailable,
  geocodeSchool: (...a) => geo(...a),
  geocodeListing: async () => null,
  reverseGeocode: async () => null,
  buildQuery: () => '',
  haversineMiles: () => 0,
});

const { getSchoolCoords } = require('./housing');
const CSULB = 'California State University, Long Beach';

test.beforeEach(() => { row = null; writes = []; geo = async () => null; });

test('a located campus is served from the cache without asking the geocoder', async () => {
  row = { latitude: '33.781800', longitude: '-118.115200', attempted_at: new Date() };
  geo = async () => { throw new Error('should not be called'); };
  assert.deepEqual(await getSchoolCoords(CSULB), { lat: 33.7818, lon: -118.1152 });
});

test('a first lookup that finds the campus is stored and returned', async () => {
  geo = async () => ({ lat: 33.7818, lon: -118.1152 });
  assert.deepEqual(await getSchoolCoords(CSULB), { lat: 33.7818, lon: -118.1152 });
  assert.deepEqual(writes[0].slice(0, 3), [CSULB, 33.7818, -118.1152]);
});

test('a geocoder that does not answer is NOT cached as "no such campus"', async () => {
  geo = async () => { throw new GeocodeUnavailable('geocoder answered 429'); };
  const orig = console.warn; console.warn = () => {};
  try { assert.equal(await getSchoolCoords(CSULB), null); } finally { console.warn = orig; }
  assert.equal(writes.length, 0, 'a failure must leave the next request free to try again');
});

test('a genuine miss is cached, so it costs one lookup a day, not one per request', async () => {
  geo = async () => null;
  assert.equal(await getSchoolCoords('Nowhere Community College'), null);
  assert.deepEqual(writes[0].slice(0, 3), ['Nowhere Community College', null, null]);
});

test('a recent miss is trusted, an old miss is looked up again and can be replaced', async () => {
  row = { latitude: null, longitude: null, attempted_at: new Date() };
  geo = async () => ({ lat: 1, lon: 2 });
  assert.equal(await getSchoolCoords(CSULB), null, 'a miss from minutes ago is not retried');
  assert.equal(writes.length, 0);

  row = { latitude: null, longitude: null, attempted_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) };
  geo = async () => ({ lat: 33.7818, lon: -118.1152 });
  assert.deepEqual(await getSchoolCoords(CSULB), { lat: 33.7818, lon: -118.1152 });
  assert.deepEqual(writes[0].slice(0, 3), [CSULB, 33.7818, -118.1152]);
});
