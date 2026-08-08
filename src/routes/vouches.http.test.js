// GET/POST /vouches/* — the public past-roommate testimonial flow, plus the
// wouldLiveAgain question added for the honest trackRecord badge (see
// vouches.trackRecord.test.js for the aggregation logic itself). This file
// locks the HTTP surface: the field round-trips into the INSERT as a real
// boolean, an omitted field stores NULL (never coerced to false — "never
// asked" must not read as "no"), and the existing validation/rate-limit/
// content-filter behavior is untouched. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let lastInsertParams = null;
let pendingCount = 0;
inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT first_name FROM users/.test(sql)) return { rows: [{ first_name: 'Riley' }] };
    if (/SELECT COUNT\(\*\)::int AS n FROM vouches/.test(sql)) return { rows: [{ n: pendingCount }] };
    if (/INSERT INTO vouches/.test(sql)) { lastInsertParams = params; return { rows: [] }; }
    return { rows: [] }; // ensureTables' CREATE/ALTER/INDEX
  },
});
inject('../lib/rateLimit', () => (req, res, next) => next());
inject('../lib/contentFilter', { screenMessage: () => ({ action: 'allow' }) });
inject('../middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'vouchee-1' }; next(); } });

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/vouches', require('./vouches'));

test.beforeEach(() => { lastInsertParams = null; pendingCount = 0; });

test('POST /vouches/:userId with wouldLiveAgain:true stores it as a real boolean', async () => {
  const res = await request(app)
    .post('/vouches/22222222-2222-2222-2222-222222222222')
    .send({ fromName: 'Jordan K.', text: 'Great to live with, very tidy.', wouldLiveAgain: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // INSERT INTO vouches (user_id, from_name, relationship, text, status, would_live_again)
  assert.equal(lastInsertParams[4], true);
});

test('POST /vouches/:userId with wouldLiveAgain:false stores false, not null', async () => {
  const res = await request(app)
    .post('/vouches/22222222-2222-2222-2222-222222222222')
    .send({ fromName: 'Jordan K.', text: 'It was fine, not great honestly.', wouldLiveAgain: false });
  assert.equal(res.status, 200);
  assert.equal(lastInsertParams[4], false);
});

test('POST /vouches/:userId with wouldLiveAgain omitted stores NULL — "never asked", not "no"', async () => {
  const res = await request(app)
    .post('/vouches/22222222-2222-2222-2222-222222222222')
    .send({ fromName: 'Jordan K.', text: 'A vouch from before this question existed.' });
  assert.equal(res.status, 200);
  assert.equal(lastInsertParams[4], null);
});

test('a non-boolean wouldLiveAgain is ignored, not stored as truthy garbage', async () => {
  const res = await request(app)
    .post('/vouches/22222222-2222-2222-2222-222222222222')
    .send({ fromName: 'Jordan K.', text: 'Testing a weird payload here.', wouldLiveAgain: 'yes' });
  assert.equal(res.status, 200);
  assert.equal(lastInsertParams[4], null);
});

test('existing validation is untouched: still 400s on a too-short vouch', async () => {
  const res = await request(app)
    .post('/vouches/22222222-2222-2222-2222-222222222222')
    .send({ fromName: 'Jordan K.', text: 'short', wouldLiveAgain: true });
  assert.equal(res.status, 400);
  assert.equal(lastInsertParams, null, 'nothing should have been inserted');
});
