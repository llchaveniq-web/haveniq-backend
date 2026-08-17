// GET /matches/matched/:userId — the zero-shared-answers fix.
//
// computeSharedAnswers is an EXACT-MATCH intersection: two people can each
// clear the "answered >= 5 questions" gate while sharing zero exactly-
// matching answers, either because they answered different questions or
// answered the same ones differently. The prompt handed to Claude still
// demanded three specific "you both [verb] [behavior]" claims "grounded in
// one of the shared answers above" — with nothing to ground them in, the
// model was left to invent specifics about two real, matched students, in
// the one screen (Matched Moment) whose whole premise is "this is
// specifically about the two of you." Zero test coverage existed for this
// route before this file. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const ME    = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

// Q48 (lifestyle, 4 options), Q49 (lifestyle, 4 options), Q14 (communication, 2 options).
let meAnswers = {};
let otherAnswers = {};
let cachedRow = null;
let insertCalls = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/CREATE TABLE IF NOT EXISTS matched_moments/.test(sql)) return { rows: [] };
    if (/SELECT 1 FROM connect_requests/.test(sql)) return { rows: [{ x: 1 }] }; // always matched
    if (/FROM users u\s+LEFT JOIN quiz_answers qa/.test(sql)) {
      return {
        rows: [
          { id: ME, first_name: 'Jordan', last_name: 'K', school: 'Ohio University', photo_url: 'x', bio: '', answers: meAnswers },
          { id: OTHER, first_name: 'Sam', last_name: 'R', school: 'Ohio University', photo_url: 'y', bio: '', answers: otherAnswers },
        ],
      };
    }
    if (/SELECT payload FROM matched_moments/.test(sql)) {
      return { rows: cachedRow ? [cachedRow] : [] };
    }
    if (/INSERT INTO matched_moments/.test(sql)) {
      insertCalls.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: ME }; next(); },
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
          why_you_two_work: 'You both keep things low-key and steady, which reads as real compatibility.',
          shared_patterns: ['you both keep it low-key most weekends'],
          conversation_starters: ['hey, fellow homebody — how has your week been?'],
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
app.use('/matches', require('./matchedMoment'));

test.beforeEach(() => {
  cachedRow = null;
  insertCalls = [];
  lastFetchBody = null;
});
test.after(() => { global.fetch = origFetch; });

test('zero exact-match overlap (each answered DIFFERENT questions) fails honestly, never calls the model', async () => {
  meAnswers    = { '48': 1, '49': 2, '14': 0, '60': 1, '62': 0 };
  otherAnswers = { '63': 1, '65': 0, '66': 1, '67': 0, '51': 1 }; // disjoint question set
  const res = await request(app).get(`/matches/matched/${OTHER}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, false);
  assert.match(res.body.reason, /quiz overlap/);
  assert.equal(lastFetchBody, null, 'the model must never be called with nothing to ground it in');
  assert.equal(insertCalls.length, 0);
});

test('zero exact-match overlap (same questions, different answers) also fails honestly', async () => {
  meAnswers    = { '48': 1, '49': 2, '14': 0, '60': 1, '62': 0 };
  otherAnswers = { '48': 3, '49': 0, '14': 1, '60': 0, '62': 1 }; // same 5 questions, every answer differs
  const res = await request(app).get(`/matches/matched/${OTHER}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, false);
  assert.equal(lastFetchBody, null);
});

test('at least one real shared answer proceeds to generate a grounded reveal', async () => {
  meAnswers    = { '48': 2, '49': 0, '14': 1, '60': 1, '62': 0 };
  otherAnswers = { '48': 2, '49': 3, '14': 0, '60': 0, '62': 1 }; // agree on Q48 only
  const res = await request(app).get(`/matches/matched/${OTHER}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, true);
  assert.equal(res.body.sharedCount, 1);
  assert.ok(lastFetchBody, 'the model IS called once there is real shared data to ground it in');
  assert.match(lastFetchBody.messages[0].content, /Most weekends/, 'the real shared answer text reached the prompt');
});

test('the too-little-quiz-data gate (below 5 answers) is unaffected by this fix', async () => {
  meAnswers    = { '48': 2 }; // only 1 answer — fails the >=5 gate, never reaches sharedAnswers logic
  otherAnswers = { '48': 2, '49': 3, '14': 0, '60': 0, '62': 1 };
  const res = await request(app).get(`/matches/matched/${OTHER}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, false);
  assert.match(res.body.reason, /finish more of the quiz/);
});
