// GET /matches/:userId/explain and GET /matches/:userId/openers — the
// AI-narrative routes that turn a compatibility score into specific claims
// about two real people ("you both said X", "you diverged on Y").
//
// Both routes used to query quiz_answers as a (user_id, question_id,
// answer_value) row-per-answer table. That schema has never existed —
// quiz_answers has ONE row per user with a JSONB `answers` column — so the
// query silently returned nothing (wrapped in a bare .catch), agreements
// and divergences were always empty, and the LLM prompt always read
// "Sample agreements: none" / "Identical quiz answers on 0 question(s)"
// regardless of what either user actually answered. The prompt still
// instructed the model to produce specific claims about the two of them,
// so the model was fabricating agreement/tension content that had zero
// grounding — for real students, about each other.
//
// These lock: (1) real overlapping quiz answers actually reach the prompt,
// with real question/option text, not a permanently-empty set; (2) when a
// pair genuinely has no shared quiz data (new user, incomplete quiz), the
// prompt says so explicitly instead of reading like a real zero-overlap
// result; (3) the backend REFUSES to pass through agreements/tension_points
// in that no-data case even if the model invents them anyway — the honesty
// guard is enforced in code, not just requested in the prompt. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const VIEWER = '11111111-1111-1111-1111-111111111111';
// Both routes cache responses per (viewer, target) pair for 24h in a
// module-level Map, so each test uses its OWN target id — otherwise a later
// test would silently get an earlier test's cached response and never call
// the "model" at all.
let targetCounter = 0;
function freshTarget() {
  targetCounter += 1;
  return `2${String(targetCounter).padStart(7, '0')}-2222-2222-2222-222222222222`;
}

// Q48 "How often do you have people over?" — 4 options, index 2 = 'Most weekends'.
// Q49 "What's your typical weekday bedtime?" — 4 options, index 0 = 'Before 10 PM', index 3 = 'After 2 AM...'.
// Q14 "Which is MORE true of you?" — 2 options, index 1 = 'Even frustrated, I keep it civil...'.
let quizRows = [];
let compatProfileRows = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT 1 FROM users\s+WHERE id = \$1 AND school/.test(sql)) {
      return { rows: [{ x: 1 }] }; // same-campus gate passes by default
    }
    if (/SELECT 1 FROM connect_requests/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT id, first_name, school, school_year, major, bio\s+FROM users\s+WHERE id IN/.test(sql)) {
      return {
        rows: [
          { id: params[0], first_name: 'Jordan', school: 'Ohio University', school_year: 'Junior', major: 'CS', bio: 'quiet, tidy' },
          { id: params[1], first_name: 'Sam', school: 'Ohio University', school_year: 'Junior', major: 'Biology', bio: 'night owl' },
        ],
      };
    }
    if (/SELECT user_id, answers FROM quiz_answers WHERE user_id IN/.test(sql)) {
      return { rows: quizRows };
    }
    if (/SELECT user_id, profile, user_edits\s+FROM compatibility_profiles WHERE user_id IN/.test(sql)) {
      return { rows: compatProfileRows };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: VIEWER, school: 'Ohio University' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});
inject('../middleware/rateLimits', {
  aiLimiter: (_q, _s, n) => n(), writeReview: (_q, _s, n) => n(), submitRule: (_q, _s, n) => n(),
  submitNomination: (_q, _s, n) => n(), quickAction: (_q, _s, n) => n(), safetyReport: (_q, _s, n) => n(),
  safetyBlock: (_q, _s, n) => n(), writeLimiter: (_q, _s, n) => n(),
});

let lastFetchBody = null;
let nextLLMReply = null; // set per test to control what the "model" returns
const origFetch = global.fetch;
global.fetch = async (_url, opts) => {
  lastFetchBody = JSON.parse(opts.body);
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: JSON.stringify(nextLLMReply) }] }),
  };
};

process.env.ANTHROPIC_API_KEY = 'test-key';

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/matches', require('./matches'));

test.beforeEach(() => {
  compatProfileRows = [];
  lastFetchBody = null;
  nextLLMReply = {
    headline: 'A quiet, steady match.',
    story: 'Jordan and Sam both keep things low-key most weekends, though their nights run on different clocks.',
    agreements: [{ topic: 'guests', detail: 'both keep it low-key most weekends' }],
    tension_points: [{ topic: 'sleep schedule', you_said: 'early sleeper', they_said: 'night owl' }],
    vibe: 'steady, mismatched hours',
  };
});
test.after(() => { global.fetch = origFetch; });

// ── /explain: real data reaches the prompt ──────────────────────────────
test('/explain prompt carries REAL shared quiz answers, not a permanently-empty set', async () => {
  const target = freshTarget();
  quizRows = [
    { user_id: VIEWER, answers: { '48': 2, '49': 0, '14': 1 } },
    { user_id: target, answers: { '48': 2, '49': 3, '14': 1 } },
  ];
  const res = await request(app).get(`/matches/${target}/explain`);
  assert.equal(res.status, 200);
  const prompt = lastFetchBody.messages[0].content;
  assert.match(prompt, /Both agreed on 2 question\(s\)/, 'Q48 and Q14 matched');
  assert.match(prompt, /Diverged on 1 question\(s\)/, 'Q49 diverged');
  assert.match(prompt, /Most weekends/, 'real option text for the agreement, not a bare Q-id');
  assert.match(prompt, /Before 10 PM/, "viewer's real divergence answer");
  assert.match(prompt, /After 2 AM/, "target's real divergence answer");
  assert.doesNotMatch(prompt, /Sample agreements: none/);
  assert.doesNotMatch(prompt, /Sample divergences: none/);
});

test('/explain never references raw question ids in the data handed to the model', async () => {
  const target = freshTarget();
  quizRows = [
    { user_id: VIEWER, answers: { '48': 2, '49': 0, '14': 1 } },
    { user_id: target, answers: { '48': 2, '49': 3, '14': 1 } },
  ];
  await request(app).get(`/matches/${target}/explain`);
  const prompt = lastFetchBody.messages[0].content;
  assert.doesNotMatch(prompt, /Q48|Q49|Q14/, 'topics are paraphrased by category/text, never bare Q-ids');
});

test('/explain returns the agreements/tension_points the model produced when real quiz data backs them', async () => {
  const target = freshTarget();
  quizRows = [
    { user_id: VIEWER, answers: { '48': 2, '49': 0, '14': 1 } },
    { user_id: target, answers: { '48': 2, '49': 3, '14': 1 } },
  ];
  const res = await request(app).get(`/matches/${target}/explain`);
  assert.equal(res.status, 200);
  assert.equal(res.body.agreements.length, 1);
  assert.equal(res.body.tension_points.length, 1);
});

// ── /explain: honest about missing data ─────────────────────────────────
test('/explain tells the model quiz data is unavailable when one side has none, instead of a false "0 agreed" read', async () => {
  const target = freshTarget();
  quizRows = [{ user_id: VIEWER, answers: { '48': 2 } }]; // target never answered
  const res = await request(app).get(`/matches/${target}/explain`);
  assert.equal(res.status, 200);
  const prompt = lastFetchBody.messages[0].content;
  assert.match(prompt, /Not available/);
  assert.match(prompt, /Do NOT invent/);
});

test('/explain STRIPS agreements/tension_points even if the model invents them with no real quiz data — code-level backstop, not just a prompt request', async () => {
  const target = freshTarget();
  quizRows = []; // neither user has completed the quiz
  nextLLMReply = {
    headline: 'Great match!',
    story: 'You both love a quiet weekend and keep things tidy.',
    agreements: [{ topic: 'made up', detail: 'fabricated by the model despite instructions' }],
    tension_points: [{ topic: 'also made up', you_said: 'a', they_said: 'b' }],
    vibe: 'invented',
  };
  const res = await request(app).get(`/matches/${target}/explain`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.agreements, [], 'no real quiz data existed to ground this — must not reach the user');
  assert.deepEqual(res.body.tension_points, []);
  // headline/story/vibe (profile+score based) still come through — this isn't a blanket failure.
  assert.equal(res.body.headline, 'Great match!');
});

test('a genuinely thin quiz overlap (few shared questions) is reported honestly, not padded', async () => {
  const target = freshTarget();
  quizRows = [
    { user_id: VIEWER, answers: { '48': 1 } },
    { user_id: target, answers: { '48': 3 } }, // both answered, but diverged, only 1 question total
  ];
  const res = await request(app).get(`/matches/${target}/explain`);
  const prompt = lastFetchBody.messages[0].content;
  assert.match(prompt, /Both agreed on 0 question\(s\)/);
  assert.match(prompt, /Diverged on 1 question\(s\)/);
  assert.equal(res.status, 200);
});

// ── /openers: shared-answer count is real ───────────────────────────────
test('/openers reports the REAL identical-answer count, not always zero', async () => {
  const target = freshTarget();
  quizRows = [
    { user_id: VIEWER, answers: { '48': 2, '49': 0, '14': 1 } },
    { user_id: target, answers: { '48': 2, '49': 3, '14': 1 } },
  ];
  nextLLMReply = ['hey, saw we both keep it pretty low-key on weekends — you settling in okay?'];
  const res = await request(app).get(`/matches/${target}/openers`);
  assert.equal(res.status, 200);
  const prompt = lastFetchBody.messages[0].content;
  assert.match(prompt, /Identical quiz answers on 2 question\(s\)/);
});

test('/openers reports zero honestly when there truly is no overlap', async () => {
  const target = freshTarget();
  quizRows = [];
  nextLLMReply = ['hey, how has your week been?'];
  const res = await request(app).get(`/matches/${target}/openers`);
  assert.equal(res.status, 200);
  const prompt = lastFetchBody.messages[0].content;
  assert.match(prompt, /Identical quiz answers on 0 question\(s\)/);
});
