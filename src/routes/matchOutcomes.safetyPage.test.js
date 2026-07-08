// A check-in note that trips the crisis (self-harm) or threat filter pages the
// founder (signal:checkin_safety_flag) — so a student in danger isn't left in a
// table someone has to remember to query. Uses the REAL content filter so the
// crisis/threat detection is genuine; pool/auth/sentry stubbed, fetch captured.
// node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

inject('../db/pool', { query: async () => ({ rows: [] }) });
inject('../middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'user-9' }; next(); } });
inject('../utils/sentry', { captureError: () => {} });   // no real Sentry init in tests
process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/hook';

// Capture outbound webhook calls instead of hitting the network.
const calls = [];
const origFetch = global.fetch;
global.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; };

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./matchOutcomes'));

const post = (details) =>
  request(app).post('/me/match-outcomes').send({ otherUserId: 'other-1', outcome: details.outcome || 'survey_30d', details });
const settle = () => new Promise((r) => setImmediate(r));   // let the fire-and-forget page run

test.beforeEach(() => { calls.length = 0; });
test.after(() => { global.fetch = origFetch; });

test('a self-harm note pages as CRISIS (and still records the outcome)', async () => {
  const res = await post({ stage: 'day30', rating: 2, note: "honestly I have been hurting myself lately and I do not know what to do" });
  assert.equal(res.status, 200);
  assert.equal(res.body.recorded, true);
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.embeds[0].title, /CRISIS/);
});

test('a threat note pages as THREAT', async () => {
  const res = await post({ stage: 'day60', note: 'my roommate said he will hurt you if we stay and it scared me' });
  assert.equal(res.status, 200);
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.embeds[0].title, /THREAT/);
});

test('a benign note does NOT page', async () => {
  const res = await post({ stage: 'day30', rating: 4, note: 'noise has been a little much but we are working it out fine' });
  assert.equal(res.status, 200);
  await settle();
  assert.equal(calls.length, 0);
});

test('no note → no page', async () => {
  const res = await post({ stage: 'day30', rating: 5 });
  assert.equal(res.status, 200);
  await settle();
  assert.equal(calls.length, 0);
});
