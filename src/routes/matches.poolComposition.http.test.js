// GET /matches/pool-composition — telling a student the truth about their pool.
//
// /feed applies five narrowing rules and the app shows two of them. Budget and
// move-in conflicts (matchViability) silently drop high-scoring candidates, so
// a student with a tight range sees a thin deck and concludes "nobody's here".
// This endpoint is the accounting behind that deck.
//
// The whole thing lives or dies on one distinction, which is what most of this
// file tests:
//
//   blocks      — attributed, first-reason-wins. PARTITIONS the removed set,
//                 so the counts sum to exactly (total - shown) and "why is my
//                 pool this size" adds up.
//   wouldReturn — leave-one-out. Only candidates failing THIS filter alone.
//                 This is what loosening it actually gives back.
//
// Reporting `blocks` as the recovery number would promise back people who
// conflict on a second axis too and will not reappear — the small lie that
// costs trust the first instant a student widens a slider and sees nothing.
//
// Also locked: the endpoint never leaks WHO was filtered out or what their
// numbers are. On a ~30-person campus, a helpful "widen your max to $1,450"
// would reveal one identifiable person's budget by differencing. node --test.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_thirty_two_chars_long_xxxx';
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const VIEWER = '11111111-1111-1111-1111-111111111111';

// The schema defaults. matchViability treats this exact pair as "never set".
const DEFAULT_BUDGET = { budget_min: 500, budget_max: 2000 };

let viewer = null;
let candidates = [];
let candidateSql = '';

inject('../db/pool', {
  query: async (sql) => {
    if (/SELECT gender, looking_for, match_dealbreakers/.test(sql)) {
      return { rows: [viewer] };
    }
    if (/FROM compatibility_scores cs/.test(sql) && /pass_gender/.test(sql)) {
      candidateSql = sql;
      return { rows: candidates };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth:  (req, _res, next) => { req.user = { id: VIEWER, school: 'Ohio University' }; next(); },
  refuseBanned: (_q, _s, n) => n(),
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/matches', require('./matches'));

/** A candidate that passes everything unless overridden. */
function cand(over = {}) {
  return {
    id: `u-${Math.abs(JSON.stringify(over).length)}-${candidates.length}`,
    pass_gender: true, pass_smoke: true, pass_school: true,
    ...DEFAULT_BUDGET, move_in_timeline: 'Flexible',
    ...over,
  };
}

const get = (qs = '') => request(app).get(`/matches/pool-composition${qs}`);
const byKey = (body, key) => body.pool.filters.find(f => f.key === key);

test.beforeEach(() => {
  viewer = {
    gender: 'Woman', looking_for: ['Woman'], match_dealbreakers: {},
    school: 'Ohio University', ...DEFAULT_BUDGET, move_in_timeline: 'Flexible',
  };
  candidates = [];
  candidateSql = '';
});

// ── 1. The counts have to add up ──────────────────────────────────────────
test('blocks partition the removed set — they sum to exactly total minus shown', async () => {
  viewer.budget_min = 600; viewer.budget_max = 900;      // a real, tight range
  candidates = [
    cand(),                                               // shown
    cand(),                                               // shown
    cand({ pass_gender: false }),                         // gender
    cand({ pass_smoke: false }),                          // smoke
    cand({ budget_min: 1500, budget_max: 2400 }),         // budget
    cand({ pass_gender: false, budget_min: 1500, budget_max: 2400 }), // gender wins
  ];
  const { body } = await get();
  assert.equal(body.pool.total, 6);
  assert.equal(body.pool.shown, 2);
  const sum = body.pool.filters.reduce((n, f) => n + f.blocks, 0);
  assert.equal(sum, body.pool.total - body.pool.shown,
    'if these do not sum, the panel cannot explain the pool size without inventing a remainder');
  assert.equal(byKey(body, 'gender').blocks, 2, 'first reason wins, in feed order');
  assert.equal(byKey(body, 'budget').blocks, 1);
});

// ── 2. The load-bearing distinction ───────────────────────────────────────
test('a candidate blocked on two axes is attributed once and recoverable by neither', async () => {
  viewer.budget_min = 600; viewer.budget_max = 900;
  viewer.move_in_timeline = '2 months';
  candidates = [
    // Outside the budget AND moving in a term later.
    cand({ budget_min: 1500, budget_max: 2400, move_in_timeline: '9 months' }),
  ];
  const { body } = await get();
  assert.equal(byKey(body, 'budget').blocks, 1, 'attributed to budget, the first axis /feed checks');
  assert.equal(byKey(body, 'budget').wouldReturn, 0,
    'widening the budget alone does NOT bring this person back — the move-in still conflicts');
  assert.equal(byKey(body, 'moveIn').blocks, 0, 'never double-counted');
  assert.equal(byKey(body, 'moveIn').wouldReturn, 0);
});

test('wouldReturn counts only sole-cause blocks, and never exceeds blocks', async () => {
  viewer.budget_min = 600; viewer.budget_max = 900;
  viewer.move_in_timeline = '2 months';
  candidates = [
    cand({ budget_min: 1500, budget_max: 2400 }),                              // budget only
    cand({ budget_min: 1500, budget_max: 2400 }),                              // budget only
    cand({ budget_min: 1500, budget_max: 2400, move_in_timeline: '9 months' }), // both
  ];
  const { body } = await get();
  assert.equal(byKey(body, 'budget').blocks, 3);
  assert.equal(byKey(body, 'budget').wouldReturn, 2,
    'exactly the two who come back when the range widens');
  for (const f of body.pool.filters) {
    assert.ok(f.wouldReturn <= f.blocks, `${f.key}: wouldReturn must never exceed blocks`);
  }
});

test('move-in is evaluated on its own axis, and is recoverable when it is the sole cause', async () => {
  // The mirror of the two tests above, which both have budget failing first.
  // Without this, an endpoint that never evaluated move-in at all would still
  // pass every other case in this file.
  viewer.move_in_timeline = '2 months';
  candidates = [
    cand({ move_in_timeline: '9 months' }),   // a term apart — the only conflict
    cand({ move_in_timeline: '3 months' }),   // inside the 45-day window
  ];
  const { body } = await get();
  assert.equal(byKey(body, 'moveIn').active, true);
  assert.equal(byKey(body, 'moveIn').blocks, 1);
  assert.equal(byKey(body, 'moveIn').wouldReturn, 1,
    'nothing else excludes this candidate, so widening the window really does return them');
  assert.equal(body.pool.shown, 1);
});

// ── 3. Fail-open rules must not show up as filters ────────────────────────
test('the schema-default budget is not a filter — it means "never set"', async () => {
  // 500-2000 is both the client default and the DB default, so it cannot be
  // distinguished from an untouched slider and must never exclude anyone.
  candidates = [cand({ budget_min: 3000, budget_max: 5000 })];
  const { body } = await get();
  assert.equal(byKey(body, 'budget').active, false,
    'reporting an untouched slider as an active filter would blame the student for a rule we never applied');
  assert.equal(byKey(body, 'budget').blocks, 0);
  assert.equal(body.pool.shown, 1);
});

test('a flexible move-in blocks nobody, however concrete the other side is', async () => {
  viewer.move_in_timeline = 'Flexible';
  candidates = [cand({ move_in_timeline: '11 months' })];
  const { body } = await get();
  assert.equal(byKey(body, 'moveIn').active, false);
  assert.equal(byKey(body, 'moveIn').blocks, 0);
  assert.equal(body.pool.shown, 1);
});

// ── 4. `active` describes the viewer, not the counts ──────────────────────
test('a filter that happens to hide nobody today still reports as active', async () => {
  candidates = [cand(), cand()];   // everyone already at the viewer's school
  const { body } = await get('?school=Ohio%20University');
  const school = byKey(body, 'school');
  assert.equal(school.active, true,
    'derived from counts, this would flip to "off" and then silently start hiding people');
  assert.equal(school.blocks, 0);
});

test('an unset gender preference reports inactive', async () => {
  viewer.looking_for = [];
  candidates = [cand()];
  const { body } = await get();
  assert.equal(byKey(body, 'gender').active, false);
});

// ── 5. No leaking who, or what their numbers are ──────────────────────────
test('the response carries counts only — no candidate ids, budgets or thresholds', async () => {
  viewer.budget_min = 600; viewer.budget_max = 900;
  candidates = [cand({ id: 'u-secret', budget_min: 1450, budget_max: 2400 })];
  const { body } = await get();
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('u-secret'), 'never name who was filtered out');
  assert.ok(!raw.includes('1450'),
    'a "widen your max to $1,450" hint reveals one identifiable person’s budget by differencing');
});

// ── 6. Non-negotiable rules are not the student's filters ─────────────────
test('bans, pauses and blocks narrow the base set and are never reported as filters', async () => {
  candidates = [cand()];
  const { body } = await get();
  const keys = body.pool.filters.map(f => f.key);
  assert.deepEqual(keys, ['gender', 'smokeFree', 'school', 'budget', 'moveIn']);
  for (const forbidden of ['banned', 'paused', 'blocked', 'score', 'quiz']) {
    assert.ok(!keys.includes(forbidden),
      `${forbidden} is not something the student can loosen — listing it would be a dead end`);
  }
  // and they really are applied to the base query
  for (const clause of ['is_banned', 'is_paused', 'quiz_completed', 'user_blocks', 'is_hard_blocked']) {
    assert.ok(candidateSql.includes(clause), `base set must still exclude on ${clause}`);
  }
});

// ── 7. Degenerate pools ───────────────────────────────────────────────────
test('an empty pool reports zeros rather than failing', async () => {
  candidates = [];
  const { body, status } = await get();
  assert.equal(status, 200);
  assert.equal(body.pool.total, 0);
  assert.equal(body.pool.shown, 0);
  assert.ok(body.pool.filters.every(f => f.blocks === 0 && f.wouldReturn === 0));
});
