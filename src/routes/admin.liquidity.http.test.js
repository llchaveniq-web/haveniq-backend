// The campus-liquidity block on GET /admin/metrics: founder gate, shape, and
// that the numbers come from the query rather than from the headline counts.
//
// This is a CONTRACT test. The pool is stubbed, so it proves the endpoint
// carries the metric and shapes it correctly; it proves NOTHING about whether
// the SQL is right. That is what scripts/liquidity-check.js is for, and it has
// been run against a real Postgres with the schema and migrations loaded.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// One lopsided campus: 15 quiz-complete students, and three of them cannot be
// put in a suite with anyone. The headline row and the liquidity row disagree
// on purpose, because that disagreement is the entire reason for the metric.
let liquidityRows = [
  { school: 'Ohio University', cohort: 15, worst: 2, p10: 2, median: 11, below_engine_floor: 3 },
];
inject('../db/pool', {
  query: async (sql) => {
    if (/FROM\s+reach/i.test(sql)) return { rows: liquidityRows };
    if (/GROUP BY school/i.test(sql)) {
      return { rows: [{ school: 'Ohio University', users: 22, verified: 15, quiz_completed: 15 }] };
    }
    if (/FROM users\s*$|COUNT\(\*\)::int AS total/i.test(sql)) {
      return { rows: [{ total: 22, verified: 15, quiz_completed: 15 }] };
    }
    if (/dimension_models/i.test(sql)) return { rows: [{ qid: null, type: null, last: null }] };
    return { rows: [{ n: 0, at_cap_today: 0, blocked_today: 0, blocked_7d: 0, blocked_attempts_7d: 0 }] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: req.headers['x-test-uid'] || 'user-1' }; next(); },
});
inject('../utils/founders', {
  isFounder: (id) => id === 'founder-1',
  isFounderEmail: () => false, isFounderUser: (u) => u && u.id === 'founder-1',
  getFounderIds: () => ['founder-1'], getFounderEmails: () => [],
});

const express = require('express');
const request = require('supertest');

// /admin/metrics caches its whole payload in a module-level variable for 60s
// (_metricsCache in admin.js), so a second request inside a minute replays the
// first one's numbers whatever the stub now returns. Found by writing the
// obvious version of this file first and watching two cases assert against the
// PREVIOUS case's data. Each test loads the router fresh so it is measuring
// its own fixture; the cache itself is pinned at the bottom.
function freshApp() {
  delete require.cache[require.resolve('./admin')];
  const app = express();
  app.use(express.json());
  app.use('/admin', require('./admin'));
  return app;
}

const metrics = (uid) => request(freshApp()).get('/admin/metrics').set('x-test-uid', uid);

test('GET /admin/metrics stays founder-only', async () => {
  const res = await metrics('user-1');
  assert.equal(res.status, 403);
});

test('liquidity reports the distribution, not just the campus total', async () => {
  const res = await metrics('founder-1');
  assert.equal(res.status, 200);
  const l = res.body.liquidity;
  assert.ok(l, 'metrics carries a liquidity block');
  const ou = l.schools.find(s => s.school === 'Ohio University');
  assert.ok(ou, 'the campus is present');

  // The two numbers that must not be confused. If these ever come back equal
  // by construction the metric has collapsed back into the headline count.
  assert.equal(res.body.schools[0].quizCompleted, 15);
  assert.equal(ou.worst, 2);
  assert.notEqual(ou.worst, res.body.schools[0].quizCompleted);

  assert.equal(ou.cohort, 15);
  assert.equal(ou.p10, 2);
  assert.equal(ou.median, 11);
  assert.equal(ou.belowEngineFloor, 3);
  // 40 (floor) - 2 (worst-served student). The gap is measured from the worst,
  // not the median: a campus is liquid when its worst-served students have
  // options. Computing it from the median would report 29 here and call a
  // campus that cannot seat three people "nearly there".
  assert.equal(ou.gapToLiquidity, 38);
});

test('a crossed campus reports a zero gap, never a negative one', async () => {
  liquidityRows = [
    { school: 'Ohio University', cohort: 120, worst: 55, p10: 61, median: 80, below_engine_floor: 0 },
  ];
  const res = await metrics('founder-1');
  const ou = res.body.liquidity.schools[0];
  assert.equal(ou.gapToLiquidity, 0);
  assert.equal(ou.belowEngineFloor, 0);
});

test('no campus with a cohort yet reports an empty list, not a zero', async () => {
  liquidityRows = [];
  const res = await metrics('founder-1');
  assert.deepEqual(res.body.liquidity.schools, []);
  // The floors are still published so the dashboard can say what it is waiting
  // for instead of rendering a blank panel.
  assert.equal(res.body.liquidity.engineFloor, 3);
  assert.equal(res.body.liquidity.liquidityFloor, 40);
});

test('the payload is cached for a minute, so two reads inside it agree', async () => {
  liquidityRows = [
    { school: 'Ohio University', cohort: 15, worst: 2, p10: 2, median: 11, below_engine_floor: 3 },
  ];
  const app = freshApp();                       // one router, two requests
  const first = await request(app).get('/admin/metrics').set('x-test-uid', 'founder-1');
  assert.equal(first.body.liquidity.schools[0].worst, 2);

  liquidityRows = [
    { school: 'Ohio University', cohort: 99, worst: 77, p10: 80, median: 90, below_engine_floor: 0 },
  ];
  const second = await request(app).get('/admin/metrics').set('x-test-uid', 'founder-1');
  // Still 2. Worth knowing before anyone stands in front of the dashboard
  // waiting for a seeding push to show up: it lags by up to a minute.
  assert.equal(second.body.liquidity.schools[0].worst, 2);
});
