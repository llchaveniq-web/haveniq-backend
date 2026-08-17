// POST /best-roommate/vote — the interaction-gate fix, and a moderation
// guard on POST /best-roommate/nominate.
//
// /vote had no check that the voter and nominee had ever matched — any
// authenticated user could vote for an arbitrary user id, and that vote
// directly feeds a real, publicly-displayed leaderboard (GET /nominees,
// sorted by vote_count). Same bug class as the fix already applied to
// matchOutcomes.js. Now requires a real accepted connect_request first.
// /nominate's free-text fields were also completely unscreened — fixed
// with the same BLOCK-tier screenMessage check every other UGC surface
// uses (it doesn't need the fuller flag/admin pipeline stories.js and
// sharedReviews.js got, since nothing reads best_roommate_nominations
// back out yet — see the file's own comment).
// pool/auth/contentFilter stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let connected = true;
let connectQueries = [];
let voteInserts = [];
let nominationInserts = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/FROM connect_requests/.test(sql)) {
      connectQueries.push({ sql, params });
      return { rows: connected ? [{ '?column?': 1 }] : [] };
    }
    if (/SELECT id FROM users WHERE id = \$1 AND is_paused = FALSE/.test(sql)) {
      return { rows: params[0] === 'paused-user' ? [] : [{ id: params[0] }] };
    }
    if (/INSERT INTO best_roommate_votes/.test(sql)) { voteInserts.push(params); return { rows: [] }; }
    if (/INSERT INTO best_roommate_nominations/.test(sql)) {
      nominationInserts.push(params);
      return { rows: [{ id: 'nom-1', nominee_name: params[1], created_at: '2026-08-16T00:00:00Z' }] };
    }
    return { rows: [] };
  },
});

const { screenMessage } = require('../lib/contentFilter');
inject('../lib/contentFilter', { screenMessage });
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'voter-1', school: 'Ohio University' }; next(); },
});
inject('../middleware/rateLimits', {
  submitNomination: (_req, _res, next) => next(),
  quickAction: (_req, _res, next) => next(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/best-roommate', require('./votes'));

test.beforeEach(() => { connected = true; connectQueries = []; voteInserts = []; nominationInserts = []; });

// ── /vote — the interaction gate ──
test('a matched (accepted connect_request) pair can vote', async () => {
  const res = await request(app).post('/best-roommate/vote').send({ nomineeId: 'nominee-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.recorded, true);
  assert.equal(voteInserts.length, 1);
});

test('an UNMATCHED pair cannot vote — this is the fix (fabricated leaderboard inflation)', async () => {
  connected = false;
  const res = await request(app).post('/best-roommate/vote').send({ nomineeId: 'stranger-1' });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /haven't matched/i);
  assert.equal(voteInserts.length, 0, 'refused before the vote was ever written');
});

test('the connection check looks either direction', async () => {
  await request(app).post('/best-roommate/vote').send({ nomineeId: 'nominee-1' });
  assert.equal(connectQueries.length, 1);
  assert.match(connectQueries[0].sql, /from_user = \$1 AND to_user = \$2/);
  assert.match(connectQueries[0].sql, /from_user = \$2 AND to_user = \$1/);
  assert.deepEqual(connectQueries[0].params, ['voter-1', 'nominee-1']);
});

test('self-voting is still rejected before the connection check even runs', async () => {
  const res = await request(app).post('/best-roommate/vote').send({ nomineeId: 'voter-1' });
  assert.equal(res.status, 400);
  assert.equal(connectQueries.length, 0);
});

test('a paused nominee is still rejected before the connection check runs (steady-state check order unaffected)', async () => {
  const res = await request(app).post('/best-roommate/vote').send({ nomineeId: 'paused-user' });
  assert.equal(res.status, 404);
  assert.equal(connectQueries.length, 0);
});

// ── /nominate — content screening ──
test('a normal nomination saves fine', async () => {
  const res = await request(app).post('/best-roommate/nominate').send({
    nomineeName: 'Jordan K',
    whyBest: 'Jordan always did the dishes same day and never let a bill go unpaid, genuinely great to live with.',
  });
  assert.equal(res.status, 201);
  assert.equal(nominationInserts.length, 1);
});

test('an abusive nomination is refused, never stored — even though nothing reads it back yet', async () => {
  const res = await request(app).post('/best-roommate/nominate').send({
    nomineeName: 'i will find you and hurt you if you do not vote for me thanks',
    whyBest: 'x'.repeat(60),
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'content_blocked');
  assert.equal(nominationInserts.length, 0);
});
