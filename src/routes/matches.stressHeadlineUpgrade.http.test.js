// GET /matches/:userId/explain — the dead stress-headline fix.
//
// quiz.js writes compatibility_scores.under_pressure with a DETERMINISTIC
// per-pattern headline at scoring time, and its own comment says the
// pair-specific version is "generated lazily on the match-detail surface
// (where /explain already does cached per-pair Claude work) and overwrites
// this." Nothing ever actually called buildStressHeadline() — zero call
// sites anywhere in the codebase — so every user has only ever seen one of
// five canned sentences, regardless of their real answers. This locks that
// /explain now actually triggers the upgrade (fire-and-forget, never
// blocking or breaking the /explain response itself), persists it, and
// stops retrying once it's no longer the fallback. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const VIEWER = '11111111-1111-1111-1111-111111111111';
let targetCounter = 0;
function freshTarget() {
  targetCounter += 1;
  return `3${String(targetCounter).padStart(7, '0')}-3333-3333-3333-333333333333`;
}

let underPressureRow = null; // { pattern, headline, styles, score } | null
let updateCalls = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT 1 FROM users\s+WHERE id = \$1 AND school/.test(sql)) return { rows: [{ x: 1 }] };
    if (/SELECT 1 FROM connect_requests/.test(sql)) return { rows: [] };
    if (/SELECT id, first_name, school, school_year, major, bio\s+FROM users\s+WHERE id IN/.test(sql)) {
      return {
        rows: [
          { id: params[0], first_name: 'Jordan', school: 'Ohio University', school_year: 'Junior', major: 'CS', bio: '' },
          { id: params[1], first_name: 'Sam', school: 'Ohio University', school_year: 'Junior', major: 'Bio', bio: '' },
        ],
      };
    }
    if (/SELECT user_id, answers FROM quiz_answers WHERE user_id IN/.test(sql)) return { rows: [] };
    if (/SELECT user_id, profile, user_edits\s+FROM compatibility_profiles WHERE user_id IN/.test(sql)) return { rows: [] };
    if (/SELECT under_pressure FROM compatibility_scores/.test(sql)) {
      return { rows: underPressureRow ? [{ under_pressure: underPressureRow }] : [] };
    }
    if (/UPDATE compatibility_scores/.test(sql)) {
      updateCalls.push(params);
      return { rows: [] };
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

let fetchCalls = [];
const origFetch = global.fetch;
global.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  fetchCalls.push(body);
  const isStressCall = /under pressure/i.test(body.messages[0].content);
  return {
    ok: true,
    json: async () => ({
      content: [{
        type: 'text',
        text: isStressCall
          ? JSON.stringify({ headline: 'Jordan needs quiet to reset, and Sam wants to talk it through right away. Worth naming that gap early.' })
          : JSON.stringify({ headline: 'A steady match.', story: 'You two would get along.', agreements: [], tension_points: [], vibe: 'calm' }),
      }],
    }),
  };
};
process.env.ANTHROPIC_API_KEY = 'test-key';

const { fallbackHeadline } = require('../services/stressInsight');
const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/matches', require('./matches'));

const settle = () => new Promise((r) => setTimeout(r, 20));

test.beforeEach(() => {
  underPressureRow = null;
  updateCalls = [];
  fetchCalls = [];
});
test.after(() => { global.fetch = origFetch; });

test('a pair with no stress data at all: no upgrade attempted, /explain still works', async () => {
  const target = freshTarget();
  const res = await request(app).get(`/matches/${target}/explain`);
  assert.equal(res.status, 200);
  await settle();
  assert.equal(updateCalls.length, 0);
  // Only the /explain narrative call happened — no stress-specific call.
  assert.equal(fetchCalls.filter((b) => /under pressure/i.test(b.messages[0].content)).length, 0);
});

test('a pair still on the deterministic fallback gets upgraded to a real, pair-specific headline', async () => {
  const target = freshTarget();
  underPressureRow = {
    pattern: 'recovery_mismatch',
    headline: fallbackHeadline('recovery_mismatch'),
    score: 62,
    styles: { 66: { a: 'solitude', b: 'co-regulate' } },
  };
  const res = await request(app).get(`/matches/${target}/explain`);
  assert.equal(res.status, 200);
  await settle();
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][2], 'Jordan needs quiet to reset, and Sam wants to talk it through right away. Worth naming that gap early.');
  assert.notEqual(updateCalls[0][2], fallbackHeadline('recovery_mismatch'));
});

test('a pair already upgraded (headline is not the fallback) is left alone — no repeat Claude calls', async () => {
  const target = freshTarget();
  underPressureRow = {
    pattern: 'recovery_mismatch',
    headline: 'A real, already-personalized sentence from a previous upgrade.',
    score: 62,
    styles: { 66: { a: 'solitude', b: 'co-regulate' } },
  };
  const res = await request(app).get(`/matches/${target}/explain`);
  assert.equal(res.status, 200);
  await settle();
  assert.equal(updateCalls.length, 0);
  assert.equal(fetchCalls.filter((b) => /under pressure/i.test(b.messages[0].content)).length, 0);
});

test('the /explain response itself never fails or blocks on the stress-headline upgrade', async () => {
  const target = freshTarget();
  underPressureRow = {
    pattern: 'both_suppress',
    headline: fallbackHeadline('both_suppress'),
    score: 40,
    styles: { 65: { a: 'suppress', b: 'suppress' } },
  };
  const start = Date.now();
  const res = await request(app).get(`/matches/${target}/explain`);
  const elapsed = Date.now() - start;
  assert.equal(res.status, 200);
  assert.ok(res.body.headline, '/explain still returns its own payload normally');
  assert.ok(elapsed < 500, '/explain does not wait on the fire-and-forget stress upgrade');
});
