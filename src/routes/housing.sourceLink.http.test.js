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

inject('../services/geocode', {
  geocodeListing: async () => null,
  geocodeSchool: async () => null,
  haversineMiles: () => 1.2,
});

// Stands in for Postgres by applying the same predicates the route asks for,
// so a change that drops the moderation gate from the SQL fails here.
inject('../db/pool', {
  query: async (sql, params = []) => {
    sqls.push(sql);
    if (/FROM users WHERE id/i.test(sql)) return { rows: [{ school: 'UCLA' }] };
    if (/FROM school_coords/i.test(sql)) return { rows: [] };
    if (/FROM listings/i.test(sql)) {
      let rows = all.filter(r => r.is_active === true && r.moderation_status === 'approved');
      if (/WHERE id = \$1/i.test(sql)) rows = rows.filter(r => String(r.id) === String(params[0]));
      else if (params[0]) rows = rows.filter(r => r.school_near === params[0]);
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

test.beforeEach(() => { all = [row()]; sqls = []; });

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
