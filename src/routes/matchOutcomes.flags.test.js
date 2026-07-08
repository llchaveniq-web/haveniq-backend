// GET /bot-admin/match-outcomes-flags — the review surface behind the check-in
// "our safety team can follow up" promise. Verifies the bot gate + that notes /
// low ratings / ended outcomes map into triage reasons. Pool/auth/bot stubbed
// via the require cache. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let fakeRows = [];
inject('../db/pool', { query: async () => ({ rows: fakeRows }) });
inject('../middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'u' }; next(); } });
// The route's bot gate (fallback impl) checks ADMIN_BOT_TOKEN + a Bearer header.
process.env.ADMIN_BOT_TOKEN = 'secret';

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/', require('./matchOutcomes'));

const authed = () => request(app).get('/bot-admin/match-outcomes-flags').set('Authorization', 'Bearer secret');

test.beforeEach(() => { fakeRows = []; });

test('flags endpoint is bot/founder-gated', async () => {
  const res = await request(app).get('/bot-admin/match-outcomes-flags');
  assert.equal(res.status, 401);
});

test('maps note / low-rating / ended into triage reasons the team can act on', async () => {
  fakeRows = [
    { id: '1', reporter_id: 'ra', other_user_id: 'ob', outcome: 'survey_30d', details: { stage: 'day30', rating: 2, note: 'noise has been rough' }, created_at: 't1' },
    { id: '2', reporter_id: 'rc', other_user_id: 'od', outcome: 'decided_not_to_continue', details: { stage: 'meet48' }, created_at: 't2' },
    { id: '3', reporter_id: 're', other_user_id: 'of', outcome: 'survey_60d', details: { stage: 'day60', rating: 5, note: 'all good, just leaving a note' }, created_at: 't3' },
  ];
  const res = await authed();
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 3);
  const byId = Object.fromEntries(res.body.flags.map(f => [f.id, f]));
  assert.deepEqual(byId['1'].reasons.sort(), ['low_rating', 'note']);
  assert.deepEqual(byId['2'].reasons, ['ended']);
  assert.deepEqual(byId['3'].reasons, ['note']);        // rating 5 is not low
  // The reviewer needs the identity + content to follow up.
  assert.equal(byId['1'].reporterId, 'ra');
  assert.equal(byId['1'].note, 'noise has been rough');
  assert.equal(byId['1'].rating, 2);
  assert.equal(byId['1'].stage, 'day30');
});

test('no flagged outcomes → count 0 (honest empty, not an error)', async () => {
  const res = await authed();
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
  assert.deepEqual(res.body.flags, []);
});
