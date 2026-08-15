// POST /users/me/match-outcomes — the interaction-gate fix.
//
// Previously this route had NO check that the reporter and otherUserId had
// ever interacted — any authenticated user could self-report
// 'moved_in_together' about an ARBITRARY user id. That single self-report
// was enough on its own to pass roommateVouches.js's everMovedInTogether
// gate, letting two colluding (or throwaway) accounts fabricate a
// mutually-confirmed public "lived together" track record with zero real
// relationship behind it, while also polluting the weight-learning
// training set this table exists to build. Now every outcome requires a
// real accepted connect_request between the two users, in either
// direction — the same relationship userPhotos.js's areConnected() and
// this route's own moved-in corroboration nudge treat as "actually
// matched". pool/auth stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let connected = true;
let connectQueries = [];
let inserts = [];
inject('../db/pool', {
  query: async (sql, params) => {
    if (/FROM connect_requests/.test(sql)) {
      connectQueries.push({ sql, params });
      return { rows: connected ? [{ '?column?': 1 }] : [] };
    }
    if (/INSERT INTO match_outcomes/.test(sql)) { inserts.push(params); return { rows: [] }; }
    return { rows: [] };
  },
});
inject('../middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'user-a' }; next(); } });
inject('../utils/sentry', { captureError: () => {} });
delete process.env.DISCORD_WEBHOOK_URL;

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./matchOutcomes'));

const post = (otherUserId, outcome = 'met_in_person') =>
  request(app).post('/me/match-outcomes').send({ otherUserId, outcome });

test.beforeEach(() => { connected = true; connectQueries = []; inserts = []; });

test('a matched (accepted connect_request) pair can log an outcome', async () => {
  const res = await post('user-b');
  assert.equal(res.status, 200);
  assert.equal(res.body.recorded, true);
  assert.equal(inserts.length, 1);
});

test('an UNMATCHED pair is refused — no fabricated outcome about a stranger', async () => {
  connected = false;
  const res = await post('total-stranger');
  assert.equal(res.status, 403);
  assert.match(res.body.error, /haven't matched/i);
  assert.equal(inserts.length, 0, 'refused before the row was ever written');
});

test('the connection check looks either direction, both params passed', async () => {
  await post('user-b');
  assert.equal(connectQueries.length, 1);
  assert.match(connectQueries[0].sql, /from_user = \$1 AND to_user = \$2/);
  assert.match(connectQueries[0].sql, /from_user = \$2 AND to_user = \$1/);
  assert.deepEqual(connectQueries[0].params, ['user-a', 'user-b']);
});

test('reporting an outcome about yourself is rejected before even checking a connection', async () => {
  const res = await post('user-a');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /yourself/i);
  assert.equal(connectQueries.length, 0);
});

test('the gate applies to every outcome type, not just moved_in_together', async () => {
  connected = false;
  for (const outcome of ['met_in_person', 'lease_signed', 'survey_30d', 'ended_roommate_relationship']) {
    const res = await post('total-stranger', outcome);
    assert.equal(res.status, 403, `outcome=${outcome} should also be gated`);
  }
  assert.equal(inserts.length, 0);
});
