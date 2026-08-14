// POST /bot-admin/signup/:userId/approve — approving a pending signup must
// trigger real scoring immediately, not just flip the flag. scoreNewMatches
// skips unverified submitters entirely (quiz.reviewGate.test.js), so a user
// who finished the quiz BEFORE being reviewed would otherwise sit with an
// empty match feed forever — nothing else ever re-triggers scoring for them.
// node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

process.env.ADMIN_BOT_TOKEN = 'test-bot-token';

let usersById = new Map();
let quizAnswersById = new Map();
let auditRows = [];
let scoreNewMatchesCalls = [];

inject('../db/pool', {
  query: async (sql, params = []) => {
    if (/CREATE TABLE IF NOT EXISTS bot_admin_audit/i.test(sql)) return { rows: [] };
    if (/CREATE INDEX IF NOT EXISTS bot_admin_audit_lookup_idx/i.test(sql)) return { rows: [] };
    if (/UPDATE users SET is_verified = TRUE, updated_at = NOW\(\) WHERE id = \$1 AND is_verified = FALSE/i.test(sql)) {
      const u = usersById.get(params[0]);
      if (!u || u.is_verified) return { rows: [] };
      u.is_verified = true;
      return { rows: [{ id: u.id }] };
    }
    if (/INSERT INTO bot_admin_audit/i.test(sql)) { auditRows.push(params); return { rows: [] }; }
    if (/SELECT answers FROM quiz_answers WHERE user_id = \$1 AND completed = TRUE/i.test(sql)) {
      const a = quizAnswersById.get(params[0]);
      return { rows: a ? [{ answers: a }] : [] };
    }
    return { rows: [] };
  },
});

// scoreNewMatches is required lazily inside the handler via require('./quiz'),
// so stubbing quiz.js's module.exports before the request fires is picked up
// correctly (no stale-reference risk — nothing captured a reference at
// require-time the way a top-level `const pool = require(...)` would).
inject('./quiz', {
  scoreNewMatches: async (userId, answers) => { scoreNewMatchesCalls.push({ userId, answers }); },
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/bot-admin', require('./botAdmin'));

test.beforeEach(() => {
  usersById = new Map();
  quizAnswersById = new Map();
  auditRows = [];
  scoreNewMatchesCalls = [];
});

const approve = (id, body = {}) =>
  request(app).post(`/bot-admin/signup/${id}/approve`).set('Authorization', 'Bearer test-bot-token').send(body);

test('approving a pending user who completed the quiz triggers scoring immediately', async () => {
  usersById.set('u-1', { id: 'u-1', is_verified: false });
  quizAnswersById.set('u-1', { 1: { type: 'option', index: 0 } });

  const res = await approve('u-1', { reason: 'looks legit' });
  assert.equal(res.status, 200);
  assert.equal(res.body.acted, true);

  assert.equal(scoreNewMatchesCalls.length, 1, 'scoreNewMatches was called for the newly-approved user');
  assert.equal(scoreNewMatchesCalls[0].userId, 'u-1');
  assert.deepEqual(scoreNewMatchesCalls[0].answers, { 1: { type: 'option', index: 0 } });
});

test('approving a pending user who has NOT finished the quiz does not call scoreNewMatches', async () => {
  usersById.set('u-2', { id: 'u-2', is_verified: false });
  // no quiz_answers row for u-2

  const res = await approve('u-2');
  assert.equal(res.status, 200);
  assert.equal(res.body.acted, true);
  assert.equal(scoreNewMatchesCalls.length, 0, 'nothing to score yet — quiz not completed');
});

test('approving an already-verified user is a no-op and does not re-score', async () => {
  usersById.set('u-3', { id: 'u-3', is_verified: true });
  quizAnswersById.set('u-3', { 1: { type: 'option', index: 0 } });

  const res = await approve('u-3');
  assert.equal(res.status, 200);
  assert.equal(res.body.acted, false);
  assert.equal(scoreNewMatchesCalls.length, 0);
});

test('a scoring failure does not fail the approval response', async () => {
  inject('./quiz', {
    scoreNewMatches: async () => { throw new Error('scoring exploded'); },
  });
  usersById.set('u-4', { id: 'u-4', is_verified: false });
  quizAnswersById.set('u-4', { 1: { type: 'option', index: 0 } });

  const res = await approve('u-4');
  assert.equal(res.status, 200);
  assert.equal(res.body.acted, true, 'approval still succeeds even though scoring threw');

  // restore for any later test in this file
  inject('./quiz', {
    scoreNewMatches: async (userId, answers) => { scoreNewMatchesCalls.push({ userId, answers }); },
  });
});
