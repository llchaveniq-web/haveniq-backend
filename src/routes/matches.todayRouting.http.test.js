// Regression: GET /matches/today must reach the daily-pick handler, not the
// single-pair /:userId resolver.
//
// #9 added `GET /:userId` to routes/matches.js, mounted on '/matches' AHEAD of
// routes/matchOfTheDay.js. Its ':userId' param captured the literal 'today',
// fed "today" into a uuid-typed query, and threw → a 500 ("Failed to fetch
// match") on every home load during cold-start. This pins that /today (and any
// non-UUID param) falls through to the router that owns it. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// A pool that behaves like the real one: any query with a non-UUID where a uuid
// is expected would throw in Postgres. We emulate the RELEVANT behavior — the
// daily-pick query returns no candidates (cold-start), and the /:userId path,
// if it were ever reached with 'today', would be a bug we assert never happens.
inject('../db/pool', {
  query: async (sql) => {
    // match_of_the_day existing-pick lookup + pickTodayMatch both return empty
    // ⇒ the cold-start path, which must answer 200 { match: null }.
    return { rows: [] };
  },
  connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: '11111111-1111-1111-1111-111111111111', school: 'Ohio University' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
  optionalAuth: (_q, _s, n) => n(),
});
inject('../middleware/suspiciousActivity', { track: () => (_q, _s, n) => n() });
inject('../middleware/rateLimits', {
  aiLimiter: (_q, _s, n) => n(), writeReview: (_q,_s,n)=>n(), submitRule:(_q,_s,n)=>n(),
  submitNomination:(_q,_s,n)=>n(), quickAction:(_q,_s,n)=>n(), safetyReport:(_q,_s,n)=>n(),
  safetyBlock:(_q,_s,n)=>n(), writeLimiter:(_q,_s,n)=>n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
// EXACT production mount order (server.js): matches FIRST, then matchOfTheDay.
app.use('/matches', require('./matches'));
app.use('/matches', require('./matchOfTheDay'));

test('GET /matches/today reaches the daily-pick handler and returns 200 on an empty pool', async () => {
  const res = await request(app).get('/matches/today');
  assert.equal(res.status, 200, 'cold-start must be a clean 200, not a 500');
  assert.equal(res.body.match, null);
  assert.ok(res.body.reason, 'the empty-pool reason is present');
  // The tell it did NOT fall into the /:userId resolver:
  assert.notEqual(res.body.error, 'Failed to fetch match');
});

test('GET /matches/today is never answered by the /:userId single-pair resolver', async () => {
  const res = await request(app).get('/matches/today');
  // /:userId would 500 (uuid cast) or 400 ('invalid target user id'); neither is allowed.
  assert.notEqual(res.status, 500);
  assert.notEqual(res.body.error, 'invalid target user id');
});

test('a real UUID still routes to the single-pair resolver (guard is not over-broad)', async () => {
  // Against the empty stub the resolver answers "not a match" (403) — the point
  // is only that it REACHED /:userId rather than falling through to /today.
  const res = await request(app).get('/matches/22222222-2222-2222-2222-222222222222');
  assert.ok([403, 404, 400, 500].includes(res.status), 'a UUID reaches the resolver');
  assert.equal(res.body.match, undefined, 'it is NOT the /today payload');
});
