// GET /matches/feed — the `reason: 'pending_review'` fix.
//
// scoreNewMatches() in quiz.js never scores an unverified account against
// anyone, in either direction (routes/quiz.reviewGate.test.js locks that).
// Until this fix, the feed route had no way to tell a pending-review user's
// empty feed apart from a genuine cold start — both were a bare `[]`, and
// the client's cold-start copy ("we'll match you the second a compatible
// student joins") is actively wrong for someone who's actually just waiting
// on manual review. This locks: the feed adds `reason: 'pending_review'`
// ONLY when it's genuinely empty AND the viewer isn't verified yet — a
// normal cold start (verified, still empty) and a normal populated feed
// both keep the plain array shape existing clients already rely on. node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const VIEWER = '11111111-1111-1111-1111-111111111111';
let viewerIsVerified = true;
let candidateRows = [];

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT gender, looking_for, match_dealbreakers, is_verified/.test(sql)) {
      return { rows: [{ gender: null, looking_for: [], match_dealbreakers: {}, is_verified: viewerIsVerified, school: 'Ohio University', budget_min: null, budget_max: null, move_in_timeline: null }] };
    }
    if (/FROM compatibility_scores cs/.test(sql)) {
      return { rows: candidateRows };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: VIEWER, school: 'Ohio University' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});
inject('../middleware/suspiciousActivity', { track: () => (_q, _s, n) => n() });

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/matches', require('./matches'));

test.beforeEach(() => {
  viewerIsVerified = true;
  candidateRows = [];
});

test('an unverified viewer with an empty feed gets reason: pending_review', async () => {
  viewerIsVerified = false;
  candidateRows = [];
  const res = await request(app).get('/matches/feed');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.matches, []);
  assert.equal(res.body.reason, 'pending_review');
});

test('a verified viewer with a genuinely empty feed gets a bare array — a real cold start is not mislabeled as pending review', async () => {
  viewerIsVerified = true;
  candidateRows = [];
  const res = await request(app).get('/matches/feed');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
  assert.equal(Array.isArray(res.body), true);
});

test('an unverified viewer is never told pending_review once real matches exist (defensive — should not currently be reachable given the write-side gate, but the read-side check must not fire on a non-empty feed)', async () => {
  viewerIsVerified = false;
  candidateRows = [{
    score: '87.5', is_soft_blocked: false, shadow_penalty: '0', breakdown: {}, why_matched: null,
    pre_validation_pct: null, validation_multiplier: null, complementary_dims: null, converging_dims: null,
    confidence: '1', under_pressure: null, candidate_answers: null,
    id: '22222222-2222-2222-2222-222222222222', first_name: 'Sam', last_name: 'R', school: 'Ohio University',
    school_year: 'Junior', major: 'Bio', bio: '', gender: null, looking_for: [], photo_url: null,
    budget_min: null, budget_max: null, move_in_timeline: null, is_verified: true, trust_score: 0,
    identity_verified_at: null, last_active_at: null, profile_complete: false,
    pairing_mbti: null, pairing_disc: null, photo_urls: null, connect_request_id: null, connect_status: null,
  }];
  const res = await request(app).get('/matches/feed');
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.body), true, 'a non-empty feed stays a bare array — reason only applies to the empty case');
});
