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
