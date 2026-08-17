// GET /search — the is_banned filter fix.
//
// Every other discovery/candidate query in the app (matches.js, quiz.js,
// activityPulse.js, profile.js, users.js) filters is_banned; search.js was
// a separate, less-guarded query path that didn't — a banned account
// stayed fully searchable by name/photo/school. This locks that the SQL
// carries the filter (asserted on the query text itself, since the pool
// is stubbed and can't enforce it for real) and that the new search-
// specific rate limiter is actually wired to the route. pool/auth
// stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let userQuerySql = null;
inject('../db/pool', {
  query: async (sql) => {
    if (/SELECT school FROM users WHERE id = \$1/.test(sql)) return { rows: [{ school: 'Ohio University' }] };
    if (/FROM users u/.test(sql)) { userQuerySql = sql; return { rows: [] }; }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'u1', school: 'Ohio University' }; next(); },
});
inject('../utils/founders', { isFounder: () => false });
inject('../lib/demoFilter', { notDemo: (col) => `${col} NOT ILIKE '%demo%'` });

let searchLimiterCalls = 0;
inject('../middleware/rateLimits', {
  search: (_req, _res, next) => { searchLimiterCalls++; next(); },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/search', require('./search'));

test.beforeEach(() => { userQuerySql = null; searchLimiterCalls = 0; });

test('the user search query filters is_banned — a banned account must not be a separate, less-guarded discovery path', async () => {
  const res = await request(app).get('/search').query({ q: 'Jo' });
  assert.equal(res.status, 200);
  assert.ok(userQuerySql, 'the user search query ran');
  assert.match(userQuerySql, /COALESCE\(u\.is_banned, FALSE\) = FALSE/);
});

test('the search-specific rate limiter is actually stacked on the route (not just defined)', async () => {
  await request(app).get('/search').query({ q: 'Jo' });
  assert.equal(searchLimiterCalls, 1);
});

test('a too-short query is a cheap no-op — no DB hit, but the route still responds', async () => {
  const res = await request(app).get('/search').query({ q: 'J' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { users: [], groups: [] });
  assert.equal(userQuerySql, null, 'never queried for a sub-2-char term');
});
