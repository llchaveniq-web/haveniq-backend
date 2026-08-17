// GET /matches/bot-admin/pending-checkins — the recipient_id fix.
//
// The query joined on messages.recipient_id, a column that has NEVER
// existed in this schema (messages has sender_id + conversation_id; the
// other participant only exists via conversations.user_a/user_b). The
// SELECT threw on every call, was swallowed by a .catch() that logs a
// generic "soft-fail" line indistinguishable from an expected missing-table
// condition, and the route has returned an empty pair list since it
// shipped — so the daily 60-day founder-outreach cron never surfaced a
// single real pair, and match_outcomes.survey_60d (the input the
// weight-learning loop needs 50 of) never accumulated. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

let conversationRow = { id: 'conv-1', user_a: A, user_b: B };
let messageRows = [];
let outcomeRows = [];
let queries = [];

inject('../db/pool', {
  query: async (sql, params) => {
    queries.push(sql);
    if (/CREATE TABLE/.test(sql)) return { rows: [] };
    if (/WITH pair_first_msg AS/.test(sql)) {
      // Emulate the real join: only pairs with a message AND inside the
      // 55-65 day window AND no existing survey_60d outcome.
      if (messageRows.length === 0) return { rows: [] };
      const firstMsgAt = messageRows.reduce((min, m) => (m.created_at < min ? m.created_at : min), messageRows[0].created_at);
      const daysAgo = (Date.now() - new Date(firstMsgAt).getTime()) / 86400000;
      if (daysAgo < 55 || daysAgo > 65) return { rows: [] };
      const alreadySurveyed = outcomeRows.some(o => o.outcome === 'survey_60d');
      if (alreadySurveyed) return { rows: [] };
      return {
        rows: [{
          user_a: conversationRow.user_a, user_b: conversationRow.user_b, first_msg_at: firstMsgAt,
          a_name: 'Jordan', a_email: 'jordan@ohio.edu', a_school: 'Ohio University',
          b_name: 'Sam', b_email: 'sam@ohio.edu', b_school: 'Ohio University',
        }],
      };
    }
    return { rows: [] };
  },
});
inject('../middleware/botAuth', {
  requireBotToken: (_req, _res, next) => next(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/matches', require('./matchOutcomes'));

const DAY_MS = 86400000;

test.beforeEach(() => {
  conversationRow = { id: 'conv-1', user_a: A, user_b: B };
  messageRows = [];
  outcomeRows = [];
  queries = [];
});

test('the query no longer references a nonexistent recipient_id column', async () => {
  await request(app).get('/matches/bot-admin/pending-checkins');
  const mainQuery = queries.find(q => /pair_first_msg/.test(q));
  assert.ok(mainQuery, 'the pending-checkins query ran');
  assert.doesNotMatch(mainQuery, /recipient_id/);
  assert.match(mainQuery, /JOIN conversations/);
});

test('a pair whose first message was 60 days ago IS surfaced — this cron used to always return empty', async () => {
  messageRows = [{ created_at: new Date(Date.now() - 60 * DAY_MS).toISOString() }];
  const res = await request(app).get('/matches/bot-admin/pending-checkins');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.pairs[0].user_a, A);
  assert.equal(res.body.pairs[0].user_b, B);
});

test('a pair whose first message was 5 days ago is NOT surfaced yet (outside the 55-65 day window)', async () => {
  messageRows = [{ created_at: new Date(Date.now() - 5 * DAY_MS).toISOString() }];
  const res = await request(app).get('/matches/bot-admin/pending-checkins');
  assert.equal(res.body.count, 0);
});

test('a pair already surveyed is not surfaced again', async () => {
  messageRows = [{ created_at: new Date(Date.now() - 60 * DAY_MS).toISOString() }];
  outcomeRows = [{ outcome: 'survey_60d' }];
  const res = await request(app).get('/matches/bot-admin/pending-checkins');
  assert.equal(res.body.count, 0);
});

test('no messages at all is an honest empty list, not a crash', async () => {
  const res = await request(app).get('/matches/bot-admin/pending-checkins');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { count: 0, pairs: [] });
});
