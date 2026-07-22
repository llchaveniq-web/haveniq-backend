'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  hasRealBudget, budgetsConflict, moveInDays, moveInConflict, isViable, applyCampusRanking, THIN_POOL,
} = require('./matchViability');

// ── budgets ────────────────────────────────────────────────────────────────
test('hasRealBudget: exact 500/2000 default is NOT real; anything else is', () => {
  assert.strictEqual(hasRealBudget(500, 2000), false); // schema default → unknown
  assert.strictEqual(hasRealBudget(600, 2000), true);
  assert.strictEqual(hasRealBudget(500, 1200), true);
  assert.strictEqual(hasRealBudget(null, 1200), false);
  assert.strictEqual(hasRealBudget(800, null), false);
});

test('budgetsConflict: only when BOTH real and ranges do not overlap', () => {
  // both real, disjoint → conflict
  assert.strictEqual(budgetsConflict({ budget_min: 500, budget_max: 800 }, { budget_min: 1500, budget_max: 2000 }), true);
  // both real, overlapping → no conflict
  assert.strictEqual(budgetsConflict({ budget_min: 500, budget_max: 1200 }, { budget_min: 1000, budget_max: 1800 }), false);
  // one side default (unknown) → never a conflict, even if the other is high
  assert.strictEqual(budgetsConflict({ budget_min: 500, budget_max: 2000 }, { budget_min: 2500, budget_max: 3000 }), false);
  // both default → no conflict
  assert.strictEqual(budgetsConflict({ budget_min: 500, budget_max: 2000 }, { budget_min: 500, budget_max: 2000 }), false);
  // touching at a boundary counts as overlap (not a conflict)
  assert.strictEqual(budgetsConflict({ budget_min: 600, budget_max: 1000 }, { budget_min: 1000, budget_max: 1500 }), false);
});

// ── move-in ──────────────────────────────────────────────────────────────
test('moveInDays: parses months, treats Flexible/NULL/garbage as unknown', () => {
  assert.strictEqual(moveInDays('2 months'), 60);
  assert.strictEqual(moveInDays('1 months'), 30);
  assert.strictEqual(moveInDays('Flexible'), null);
  assert.strictEqual(moveInDays(null), null);
  assert.strictEqual(moveInDays('soon'), null);
});

test('moveInConflict: only when BOTH concrete and >45 days apart', () => {
  assert.strictEqual(moveInConflict({ move_in_timeline: '1 months' }, { move_in_timeline: '6 months' }), true);  // 150d
  assert.strictEqual(moveInConflict({ move_in_timeline: '2 months' }, { move_in_timeline: '3 months' }), false); // 30d
  assert.strictEqual(moveInConflict({ move_in_timeline: 'Flexible' }, { move_in_timeline: '6 months' }), false); // flexible passes
  assert.strictEqual(moveInConflict({ move_in_timeline: null }, { move_in_timeline: '6 months' }), false);       // unknown passes
});

// ── combined ─────────────────────────────────────────────────────────────
test('isViable: viable unless a hard conflict, with reason', () => {
  assert.deepStrictEqual(isViable({}, {}), { viable: true, reason: null });
  assert.deepStrictEqual(
    isViable({ budget_min: 500, budget_max: 700 }, { budget_min: 1800, budget_max: 2500 }),
    { viable: false, reason: 'budget' });
  assert.deepStrictEqual(
    isViable({ move_in_timeline: '1 months' }, { move_in_timeline: '8 months' }),
    { viable: false, reason: 'moveIn' });
});

// ── campus / thin-pool ────────────────────────────────────────────────────
test('applyCampusRanking: same-school only when pool is healthy', () => {
  const rows = [
    { id: 1, school: 'CSUF' }, { id: 2, school: 'CSUF' }, { id: 3, school: 'CSUF' },
    { id: 4, school: 'CSUF' }, { id: 5, school: 'CSUF' }, { id: 6, school: 'UCLA' },
  ];
  const out = applyCampusRanking(rows, 'CSUF');
  assert.strictEqual(out.length, 5, '>= THIN_POOL same-school → cross dropped');
  assert.ok(out.every(r => r.school === 'CSUF'));
});

test('applyCampusRanking: thin same-school pool falls back to cross-school', () => {
  const rows = [
    { id: 1, school: 'CSUF' }, { id: 2, school: 'CSUF' },
    { id: 6, school: 'UCLA' }, { id: 7, school: 'USC' },
  ];
  const out = applyCampusRanking(rows, 'CSUF');
  assert.strictEqual(out.length, 4, 'thin pool keeps cross-school as fallback');
  assert.deepStrictEqual(out.map(r => r.id), [1, 2, 6, 7], 'same-school first, order preserved');
});

test('applyCampusRanking: unknown viewer school is a no-op (never strands)', () => {
  const rows = [{ id: 1, school: 'CSUF' }, { id: 2, school: 'UCLA' }];
  assert.deepStrictEqual(applyCampusRanking(rows, null), rows);
});

test('THIN_POOL is the documented 5', () => {
  assert.strictEqual(THIN_POOL, 5);
});

// ── The cross-school bridge, end to end (spec §10) ──────────────────────────
// Grouping is how campus preference is expressed: same-school first, and
// cross-school appended ONLY when the home campus is thin. Note this is a
// GROUPING, not a score penalty — the displayed compatibility % stays true.
test('applyCampusRanking: a thin campus bridges to cross-school', () => {
  const rows = [
    { id: 'a', school: 'Ohio University', score: 80 },
    { id: 'b', school: 'Ohio State',      score: 99 },
    { id: 'c', school: 'Ohio State',      score: 70 },
  ];
  const out = applyCampusRanking(rows, 'Ohio University');
  assert.equal(out.length, 3, 'a thin campus must not be left with an empty feed');
  assert.equal(out[0].id, 'a', 'the same-school candidate leads even at a LOWER score');
  assert.ok(out.slice(1).every(r => r.school !== 'Ohio University'));
});

test('applyCampusRanking: a healthy campus never bridges', () => {
  const rows = [];
  for (let i = 0; i < THIN_POOL; i++) rows.push({ id: 's' + i, school: 'Ohio University', score: 60 + i });
  rows.push({ id: 'x', school: 'Ohio State', score: 100 });
  const out = applyCampusRanking(rows, 'Ohio University');
  assert.equal(out.length, THIN_POOL);
  assert.ok(!out.some(r => r.school === 'Ohio State'), 'a 100 elsewhere must not enter a healthy pool');
});

test('applyCampusRanking: scores are never modified, only grouped', () => {
  // The alternative design (subtract N from cross-school scores) would make the
  // compatibility % shown to a student a fiction. Ranking must not rewrite it.
  const rows = [
    { id: 'a', school: 'Ohio University', score: 80 },
    { id: 'b', school: 'Ohio State',      score: 99 },
  ];
  const out = applyCampusRanking(rows, 'Ohio University');
  assert.equal(out.find(r => r.id === 'b').score, 99, 'cross-school score must be untouched');
  assert.equal(out.find(r => r.id === 'a').score, 80);
});

test('applyCampusRanking: an unknown viewer school strands nobody', () => {
  const rows = [{ id: 'a', school: 'Ohio University', score: 80 }];
  assert.deepEqual(applyCampusRanking(rows, null), rows);
  assert.deepEqual(applyCampusRanking(rows, undefined), rows);
});
