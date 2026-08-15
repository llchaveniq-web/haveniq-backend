// Mutual-confirmation nudge for 'moved_in_together' — today a one-sided
// self-report is enough to unlock the roommate-vouch gate AND feed the
// weight-learning training set, so the app should actively ask the OTHER
// side to corroborate it rather than leaving it silently one-sided forever.
// Locks: the push only fires for moved_in_together (not other outcomes),
// only when the reverse direction hasn't already reported it, targets the
// OTHER user (never the reporter), and never blocks/breaks the response —
// even the "already corroborated" check failing must not fail the request.
// pool/auth/push stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let reverseAlreadyReported = false;
let insertedOutcome = null;
inject('../db/pool', {
  query: async (sql, params) => {
    // Every test here is about an already-matched pair — the interaction
    // gate (areConnected) is exercised separately in matchOutcomes.interactionGate.http.test.js.
    if (/FROM connect_requests/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/INSERT INTO match_outcomes/.test(sql)) { insertedOutcome = params; return { rows: [] }; }
    if (/SELECT 1 FROM match_outcomes/.test(sql)) return { rows: reverseAlreadyReported ? [{ '?column?': 1 }] : [] };
    return { rows: [] };
  },
});
inject('../middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'user-a', first_name: 'Jordan' }; next(); } });
inject('../utils/sentry', { captureError: () => {} });
delete process.env.DISCORD_WEBHOOK_URL;

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
let pushCalls = [];
app.set('sendPushToUser', (userId, payload) => { pushCalls.push({ userId, payload }); return Promise.resolve(); });
app.use('/', require('./matchOutcomes'));

const post = (outcome) =>
  request(app).post('/me/match-outcomes').send({ otherUserId: 'user-b', outcome });

// The nudge fires from a fire-and-forget IIFE — give it a tick to run before asserting.
const flush = () => new Promise(r => setImmediate(r));

test.beforeEach(() => { reverseAlreadyReported = false; insertedOutcome = null; pushCalls = []; });

test('a first-time moved_in_together report nudges the OTHER user, not the reporter', async () => {
  const res = await post('moved_in_together');
  assert.equal(res.status, 200);
  await flush();
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].userId, 'user-b');
  assert.match(pushCalls[0].payload.title, /move in together too/i);
});

test('no nudge once the reverse direction has already reported — already corroborated', async () => {
  reverseAlreadyReported = true;
  const res = await post('moved_in_together');
  assert.equal(res.status, 200);
  await flush();
  assert.equal(pushCalls.length, 0);
});

test('other outcomes never trigger the nudge — only moved_in_together', async () => {
  const res = await post('met_in_person');
  assert.equal(res.status, 200);
  await flush();
  assert.equal(pushCalls.length, 0);
});

test('the outcome itself is still recorded regardless of the nudge', async () => {
  const res = await post('moved_in_together');
  assert.equal(res.status, 200);
  assert.equal(insertedOutcome[0], 'user-a');
  assert.equal(insertedOutcome[1], 'user-b');
  assert.equal(insertedOutcome[2], 'moved_in_together');
});
