// GET /matches/:userId attaches `trackRecord` (docs/BACKEND_ROOMMATE_REPUTATION.md),
// sourced from the mutual, verified roommate_vouches system (roommateVouches.js),
// so the frontend's already-shipped TrackRecordBadge lights up. Locks: the
// field is present when the target has earned vouches, ABSENT (not null-
// valued) when they have none — buildMatchDTO's own "omit, don't null" idiom
// — and a broken trackRecord query never takes down match-detail (best-
// effort; the badge is a bonus, the match screen is not). node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const VIEWER = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

function matchRow(overrides = {}) {
  return {
    score: '87.5', is_soft_blocked: false, shadow_penalty: '0',
    breakdown: {}, why_matched: null, pre_validation_pct: null,
    validation_multiplier: null, complementary_dims: null, converging_dims: null,
    confidence: '1', under_pressure: null, candidate_answers: null,
    id: TARGET, first_name: 'Maya', last_name: 'Chen', school: 'UCLA',
    school_year: 'Sophomore', major: 'Business', bio: 'Tidy.', gender: 'Female',
    looking_for: ['Female'], photo_url: null, budget_min: 800, budget_max: 1400,
    move_in_timeline: 'Fall', is_verified: true, trust_score: 40,
    identity_verified_at: null, last_active_at: null, profile_complete: true,
    pairing_mbti: null, pairing_disc: null, photo_urls: null,
    connect_request_id: null, connect_status: null,
    ...overrides,
  };
}

// Mutable per-test knobs.
let trackRecordCountRow = { lived_with_count: 0, would_live_again_count: 0 };
let trackRecordThrows   = false;

inject('../db/pool', {
  query: async (sql) => {
    if (/school IS NOT NULL/.test(sql))            return { rows: [{ '?column?': 1 }] }; // same-school → mayViewMatchDetail true
    if (/blocker_id/.test(sql))                    return { rows: [] };                  // not blocked
    if (/FROM personality_profiles WHERE user_id/.test(sql)) return { rows: [] };
    if (/SELECT school FROM users WHERE id/.test(sql))       return { rows: [{ school: 'UCLA' }] };
    if (/FROM quiz_answers WHERE user_id/.test(sql))          return { rows: [] };
    if (/FROM compatibility_scores cs/.test(sql))  return { rows: [matchRow()] };
    // computeTrackRecord's two queries (roommateVouches.js):
    if (/JOIN users u ON u\.id = rv\.from_user_id/.test(sql)) {
      if (trackRecordThrows) throw new Error('db exploded');
      return { rows: [] };
    }
    if (/lived_with_count/.test(sql)) {
      if (trackRecordThrows) throw new Error('db exploded');
      return { rows: [trackRecordCountRow] };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: VIEWER, school: 'UCLA' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/matches', require('./matches'));

test.beforeEach(() => {
  trackRecordCountRow = { lived_with_count: 0, would_live_again_count: 0 };
  trackRecordThrows   = false;
});

test('a target with zero approved vouches: trackRecord is absent, not a zeroed object', async () => {
  const res = await request(app).get(`/matches/${TARGET}`);
  assert.equal(res.status, 200);
  assert.equal('trackRecord' in res.body, false);
});

test('a target with an earned track record: trackRecord is attached with the real counts', async () => {
  trackRecordCountRow = { lived_with_count: 2, would_live_again_count: 1 };
  const res = await request(app).get(`/matches/${TARGET}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.trackRecord.livedWithCount, 2);
  assert.equal(res.body.trackRecord.wouldLiveAgainCount, 1);
  assert.equal(res.body.trackRecord.display, 'Lived with 2 roommates · 1 would live again');
});

test('a broken trackRecord query never breaks match-detail — best-effort only', async () => {
  trackRecordThrows = true;
  const res = await request(app).get(`/matches/${TARGET}`);
  assert.equal(res.status, 200, 'the match itself must still load');
  assert.equal(res.body.userId, TARGET);
  assert.equal('trackRecord' in res.body, false);
});
