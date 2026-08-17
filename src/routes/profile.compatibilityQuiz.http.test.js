// compatibility_profiles' schema + the synthesis pipeline's quiz read.
//
// Two independent, silent breaks in this file:
//   1. compatibility_profiles/profile_external_signals declared
//      `user_id BIGINT REFERENCES users(id)` against a UUID users.id — the
//      FK never type-checks, so CREATE TABLE has failed on every single
//      call since this file was written (caught by a bare .catch and
//      logged, never surfaced). The table has never existed: every
//      GET/PATCH/DELETE/synthesize call against it was silently dead.
//   2. gatherUserData() queried quiz_answers as a (user_id, question_id,
//      answer_value) row-per-answer table that has never existed —
//      quiz_answers has ONE row per user with a JSONB `answers` column —
//      so even with the table fixed, every synthesized profile would be
//      built from a permanently-empty quiz array.
//
// These lock: the table is now declared with a UUID key, and the
// synthesis prompt actually carries a user's real quiz answers (question
// text + the option they chose), not an empty array. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// POST /me/profile/synthesize rate-limits to one call per user per 6h via a
// module-level Map, so each test authenticates as a DIFFERENT user — real
// user ids are UUIDs, so any distinct string works against these stubs.
let userCounter = 0;
function freshUser() {
  userCounter += 1;
  return `1${String(userCounter).padStart(7, '0')}-1111-1111-1111-111111111111`;
}
let currentUser = freshUser();

let quizAnswersRow = { answers: { '48': 2, '14': 1 } }; // 'Most weekends' guests, keeps it civil
let createTableCalls = [];
let insertCalls = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/CREATE TABLE IF NOT EXISTS compatibility_profiles/.test(sql)) {
      createTableCalls.push(sql);
      return { rows: [] };
    }
    if (/CREATE TABLE IF NOT EXISTS profile_external_signals/.test(sql)) {
      return { rows: [] };
    }
    if (/CREATE INDEX/.test(sql)) {
      return { rows: [] };
    }
    if (/FROM users WHERE id = \$1/.test(sql)) {
      return { rows: [{ id: params[0], first_name: 'Jordan', school: 'Ohio University', school_year: 'Junior', major: 'CS', bio: 'quiet, tidy', created_at: new Date('2026-01-01') }] };
    }
    if (/SELECT answers FROM quiz_answers WHERE user_id = \$1/.test(sql)) {
      return { rows: quizAnswersRow ? [quizAnswersRow] : [] };
    }
    if (/FROM messages/.test(sql)) return { rows: [] };
    if (/FROM profile_external_signals/.test(sql)) return { rows: [] };
    if (/FROM telemetry_events/.test(sql)) return { rows: [] };
    if (/INSERT INTO compatibility_profiles/.test(sql)) {
      insertCalls.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: currentUser }; next(); },
});

let lastFetchBody = null;
const origFetch = global.fetch;
global.fetch = async (_url, opts) => {
  lastFetchBody = JSON.parse(opts.body);
  return {
    ok: true,
    json: async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          version: 1,
          communication_style: { warmth: 0.7, directness: 0.6, humor: 'warm', response_pace: 'measured' },
          lifestyle: { chronotype: 'flexible', social_battery: 'medium', tidy_threshold: 'high', guest_comfort: 'selective' },
          values: ['honesty', 'calm', 'independence'],
          conflict_pattern: 'talks it out directly, without escalating.',
          roommate_archetype: 'the quiet anchor',
          user_facing_summary: 'You keep things steady and speak up early.',
          growth_edges: ['could invite more spontaneity'],
          vector: new Array(16).fill(0.1),
          confidence_notes: 'thin on external signals',
        }),
      }],
    }),
  };
};

process.env.ANTHROPIC_API_KEY = 'test-key';

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/users', require('./profile'));

test.beforeEach(() => {
  currentUser = freshUser();
  quizAnswersRow = { answers: { '48': 2, '14': 1 } };
  createTableCalls = [];
  insertCalls = [];
  lastFetchBody = null;
});
test.after(() => { global.fetch = origFetch; });

test('compatibility_profiles is declared with a UUID key that actually matches users.id, not BIGINT', async () => {
  await request(app).post('/users/me/profile/synthesize');
  assert.equal(createTableCalls.length, 1);
  assert.match(createTableCalls[0], /user_id\s+UUID PRIMARY KEY REFERENCES users\(id\)/);
  assert.doesNotMatch(createTableCalls[0], /BIGINT/);
});

test('synthesize sends the user\'s REAL quiz answers to the model, not a permanently-empty array', async () => {
  const res = await request(app).post('/users/me/profile/synthesize');
  assert.equal(res.status, 200);
  const bundle = JSON.parse(lastFetchBody.messages[0].content.match(/DATA:\n([\s\S]*?)\n\nProduce ONLY/)[1]);
  assert.ok(Array.isArray(bundle.quiz), 'quiz is present in the data bundle');
  assert.ok(bundle.quiz.length > 0, 'quiz answers actually reached the synthesis prompt');
  assert.deepEqual(bundle.quiz.find((q) => q.question_id === 48), {
    question_id: 48, category: 'lifestyle', question: 'How often do you have people over?', answer: 'Most weekends',
  });
});

test('a user who has not completed the quiz yields an honest empty quiz array, not a crash', async () => {
  quizAnswersRow = null;
  const res = await request(app).post('/users/me/profile/synthesize');
  assert.equal(res.status, 200);
  const bundle = JSON.parse(lastFetchBody.messages[0].content.match(/DATA:\n([\s\S]*?)\n\nProduce ONLY/)[1]);
  assert.deepEqual(bundle.quiz, []);
});

test('the synthesized profile is actually persisted (INSERT reached — the table exists now)', async () => {
  const res = await request(app).post('/users/me/profile/synthesize');
  assert.equal(res.status, 200);
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0][0], currentUser);
});
