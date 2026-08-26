// GET /housing/listings and /housing/listings/:id — the moderation gate, and
// the source link a collected listing needs to be actionable.
//
// A collected listing has no contact details at all: Craigslist relays mail and
// exposes no address, and a Uloop page is a building rather than a person. Both
// routes therefore have to hand back where the listing came from, or a student
// gets a price, a photo, and no way to enquire about either.
//
// The gate is tested alongside it because these two queries are the line the
// "no fake listings" promise rests on, and they had no test at all.
// node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let all = [];
let sqls = [];

inject('../middleware/auth', {
  requireAuth: (req, res, next) => {
    const uid = req.headers['x-test-uid'];
    req.user = uid ? { id: uid } : null;
    if (!req.user) return res.status(401).json({ error: 'unauth' });
    next();
  },
});

let campusCoords = { lat: 34.0224, lon: -118.2851 };   // USC

inject('../services/geocode', {
  geocodeListing: async () => null,
  geocodeSchool: async () => null,
  // The real one. A stub returning a constant would make every distance test
  // pass regardless of where the listing actually is.
  haversineMiles: (a, b) => {
    if (!a || !b) return null;
    const R = 3958.7613, rad = d => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  },
});

// Stands in for Postgres by applying the same predicates the route asks for,
// so a change that drops the moderation gate from the SQL fails here.
inject('../db/pool', {
  query: async (sql, params = []) => {
    sqls.push(sql);
    if (/FROM users WHERE id/i.test(sql)) return { rows: [{ school: 'UCLA' }] };
    if (/FROM school_coords/i.test(sql)) {
      return { rows: campusCoords ? [{ latitude: campusCoords.lat, longitude: campusCoords.lon }] : [] };
    }
    if (/INSERT INTO school_coords/i.test(sql)) return { rows: [] };
    if (/FROM listings/i.test(sql)) {
      let rows = all.filter(r => r.is_active === true && r.moderation_status === 'approved');
      if (/WHERE id = \$1/i.test(sql)) return { rows: rows.filter(r => String(r.id) === String(params[0])) };
      if (params[0]) {
        const [school, , , , , cLat, cLon, latPad, lonPad] = params;
        rows = rows.filter(r => {
          if (cLat == null) return r.school_near === school;
          if (r.latitude == null) return r.school_near === school;
          const la = Number(r.latitude), lo = Number(r.longitude);
          return la >= cLat - latPad && la <= cLat + latPad
              && lo >= cLon - lonPad && lo <= cLon + lonPad;
        });
      }
      // Honour LIMIT/OFFSET the way Postgres would, or a test asserting the
      // cap passes no matter what the route bound.
      if (/LIMIT \$4 OFFSET \$5/i.test(sql)) {
        const [, , , limit, offset] = params;
        rows = rows.slice(offset ?? 0, (offset ?? 0) + (limit ?? rows.length));
      }
      return { rows };
    }
    return { rows: [] };
  },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/housing', require('./housing'));

const AS_USER = { 'x-test-uid': 'u1' };

const row = (over = {}) => ({
  id: 1, address: '412 Bardeen Ave', city: 'Los Angeles', school_near: 'UCLA',
  beds: 2, baths: 1, latitude: '34.0689', longitude: '-118.4452',
  total_rent_cents: 240000, per_person_rent_cents: 120000,
  photo_url: 'https://images.craigslist.org/a.jpg',
  contact_name: null, contact_email: null, contact_phone: null,
  available_from: null, notes: 'n', created_at: new Date(),
  moderation_status: 'approved', is_active: true,
  source: 'craigslist', source_url: 'https://www.craigslist.org/view/d/x/abc',
  ...over,
});

test.beforeEach(() => { all = [row()]; sqls = []; campusCoords = { lat: 34.0224, lon: -118.2851 }; });

test('the browse list hands back where a listing came from', async () => {
  const res = await request(app).get('/housing/listings').set(AS_USER);
  assert.equal(res.status, 200);
  const l = res.body.listings[0];
  assert.equal(l.source, 'craigslist');
  assert.equal(l.sourceUrl, 'https://www.craigslist.org/view/d/x/abc');
});

test('the detail view hands back the same', async () => {
  const res = await request(app).get('/housing/listings/1').set(AS_USER);
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'craigslist');
  assert.equal(res.body.sourceUrl, 'https://www.craigslist.org/view/d/x/abc');
});

test('a collected listing with no contact details is still actionable', async () => {
  // This is the whole point. Every contact field is null on a collected row,
  // so sourceUrl is the only route back to whoever is letting the place.
  const res = await request(app).get('/housing/listings').set(AS_USER);
  const l = res.body.listings[0];
  assert.equal(l.contactEmail, null);
  assert.equal(l.contactPhone, null);
  assert.ok(l.sourceUrl, 'a listing with no contact and no source link is a dead end');
});

test('a listing a student posted has no source and that is fine', async () => {
  all = [row({ source: null, source_url: null, contact_email: 'a@b.edu' })];
  const res = await request(app).get('/housing/listings').set(AS_USER);
  assert.equal(res.body.listings[0].source, null);
  assert.equal(res.body.listings[0].sourceUrl, null);
  assert.equal(res.body.listings[0].contactEmail, 'a@b.edu');
});

test('a pending listing is never browsable, whatever else is true of it', async () => {
  // The line the "no fake listings" promise rests on. 660 collected listings
  // sit at 'pending'; if this predicate is ever dropped they all go live.
  all = [row({ moderation_status: 'pending' })];
  const res = await request(app).get('/housing/listings').set(AS_USER);
  assert.deepEqual(res.body.listings, []);
  // Belt and braces: the predicate must be in the SQL, not just enforced by
  // the stub. The route fires other queries after this one, so look at all.
  assert.ok(sqls.some(q => /FROM listings/i.test(q) && /moderation_status = 'approved'/.test(q)),
    'the listings query must filter on moderation_status');
});

test('a pending listing is not reachable by guessing its id either', async () => {
  all = [row({ moderation_status: 'pending' })];
  const res = await request(app).get('/housing/listings/1').set(AS_USER);
  assert.equal(res.status, 404);
});

test('a rejected or deactivated listing stays out of both routes', async () => {
  for (const over of [{ moderation_status: 'rejected' }, { is_active: false }]) {
    all = [row(over)];
    assert.deepEqual((await request(app).get('/housing/listings').set(AS_USER)).body.listings, []);
    assert.equal((await request(app).get('/housing/listings/1').set(AS_USER)).status, 404);
  }
});

test('browsing requires a signed-in student', async () => {
  assert.equal((await request(app).get('/housing/listings')).status, 401);
  assert.equal((await request(app).get('/housing/listings/1')).status, 401);
});

test('the browse list is not capped at 50 any more', async () => {
  // A hardcoded LIMIT 50 quietly became the product: with a collector filing
  // hundreds per campus, a student filtering by price was filtering 50 rows
  // rather than the market. Filtering happens client-side, so the screen needs
  // the whole campus in hand.
  all = Array.from({ length: 300 }, (_, i) => row({ id: i + 1 }));
  const res = await request(app).get('/housing/listings?limit=500').set(AS_USER);
  assert.equal(res.body.listings.length, 300, 'all 300 should come back, not 50');
});

test('one request cannot ask for the whole table', async () => {
  // 600 rows available, 500 is the ceiling — so a passing result here means the
  // cap was really applied, not that the fixture happened to be small.
  all = Array.from({ length: 600 }, (_, i) => row({ id: i + 1 }));
  const res = await request(app).get('/housing/listings?limit=99999').set(AS_USER);
  assert.equal(res.body.listings.length, 500);
});

test('a junk limit falls back to the default instead of erroring', async () => {
  all = [row()];
  for (const l of ['abc', '-5', '0', '']) {
    const res = await request(app).get(`/housing/listings?limit=${l}`).set(AS_USER);
    assert.equal(res.status, 200, l);
    assert.equal(res.body.listings.length, 1);
  }
});

// ─── Distance, not labels ─────────────────────────────────────────────────
//
// The bug these exist for: 480 real listings were tagged school_near 'UCLA'
// because that was the collector's configured target, and every student on the
// app was at USC or Orange Coast College. Nobody was at UCLA, so nobody saw
// anything. A downtown apartment is near USC whatever a label says.

const USC = { lat: 34.0224, lon: -118.2851 };
const at = (lat, lon, over = {}) => row({ latitude: String(lat), longitude: String(lon), ...over });

test('a listing labelled for another campus still shows if it is nearby', async () => {
  // Downtown LA, 2 miles from USC, tagged UCLA. This is the actual 480 rows.
  all = [at(34.0407, -118.2468, { school_near: 'UCLA' })];
  const res = await request(app).get('/housing/listings?school=USC').set(AS_USER);
  assert.equal(res.body.listings.length, 1, 'a nearby listing must not be hidden by its label');
  assert.ok(res.body.listings[0].distanceMi < 5);
});

test('a listing on the right label but the wrong side of the state does not', async () => {
  // Sacramento, ic tagged USC. The label alone must not be enough.
  all = [at(38.5816, -121.4944, { school_near: 'USC' })];
  const res = await request(app).get('/housing/listings?school=USC').set(AS_USER);
  assert.deepEqual(res.body.listings, []);
});

test('the corners of the bounding box are trimmed by real distance', async () => {
  // A square around a circle reaches ~41% further at the diagonal. This point
  // is inside the box on both axes and 40+ miles away, so only the haversine
  // pass can reject it.
  const d = 30 / 69;
  all = [at(USC.lat + d * 0.99, USC.lon + d * 0.99, { school_near: 'USC' })];
  const inBox = await request(app).get('/housing/listings?school=USC&radiusMi=30').set(AS_USER);
  assert.deepEqual(inBox.body.listings, [], 'diagonal corner should be trimmed');
});

test('radiusMi widens and narrows the search', async () => {
  all = [at(34.0689, -118.4452, { school_near: 'UCLA' })];   // UCLA, ~12mi from USC
  const wide = await request(app).get('/housing/listings?school=USC&radiusMi=30').set(AS_USER);
  const tight = await request(app).get('/housing/listings?school=USC&radiusMi=5').set(AS_USER);
  assert.equal(wide.body.listings.length, 1);
  assert.deepEqual(tight.body.listings, []);
});

test('a listing with no coordinates falls back to its label', async () => {
  // It cannot be placed any other way, so the label is all there is.
  all = [row({ latitude: null, longitude: null, school_near: 'USC' })];
  const mine = await request(app).get('/housing/listings?school=USC').set(AS_USER);
  assert.equal(mine.body.listings.length, 1);
  all = [row({ latitude: null, longitude: null, school_near: 'UCLA' })];
  const theirs = await request(app).get('/housing/listings?school=USC').set(AS_USER);
  assert.deepEqual(theirs.body.listings, []);
});

test('an unlocatable campus falls back to labels rather than showing nothing', async () => {
  // If we cannot place the school, distance is not on offer — and returning an
  // empty tab would be worse than the label we already have.
  campusCoords = null;
  all = [at(34.0407, -118.2468, { school_near: 'USC' }), at(34.0689, -118.4452, { school_near: 'UCLA' })];
  const res = await request(app).get('/housing/listings?school=USC').set(AS_USER);
  assert.equal(res.body.listings.length, 1);
  assert.equal(res.body.listings[0].schoolNear, 'USC');
});

test('the moderation gate still holds under distance filtering', async () => {
  // The new WHERE clause must not have loosened the line the promise rests on.
  all = [at(34.0407, -118.2468, { school_near: 'UCLA', moderation_status: 'pending' })];
  const res = await request(app).get('/housing/listings?school=USC').set(AS_USER);
  assert.deepEqual(res.body.listings, []);
});
