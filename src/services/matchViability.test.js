'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  hasRealBudget, budgetsConflict, realMoveIn, hasRealMoveIn, moveInConflict,
  isViable, applyCampusRanking, THIN_POOL, MOVE_IN_VALUES, MOVE_IN_SOON,
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
// ── move-in ────────────────────────────────────────────────────────────────
//
// This filter excluded nobody, ever. It parsed move_in_timeline as "N months"
// and compared the gap in days, which was right for a format the app stopped
// sending. The picker offers five values and routes/users.js accepts exactly
// those five, and not one of them parses, so every pair came back viable: a
// student moving in this month and a student moving in next fall matched
// freely at any score. The old tests passed because they only ever fed it the
// dead format.
//
// So these use the values that can actually be in the column, and the first
// one asserts the vocabulary itself.

test('the vocabulary matches what the picker offers and the API accepts', () => {
  assert.deepStrictEqual(
    [...MOVE_IN_VALUES].sort(),
    ['1-3_months', 'fall_semester', 'flexible', 'spring_semester', 'this_month']);
  assert.deepStrictEqual([...MOVE_IN_SOON].sort(), ['1-3_months', 'this_month']);
});

// A student who really answered. The stamp is what separates an answer from
// the leftover the old lease-length picker wrote into this column.
const answered = (t) => ({ move_in_timeline: t, move_in_set_at: '2026-09-22T00:00:00Z' });

test('realMoveIn: only a stamped, concrete, known value counts', () => {
  assert.strictEqual(realMoveIn(answered('this_month')), 'this_month');
  assert.strictEqual(realMoveIn(answered('flexible')), null,  'flexible fits everyone');
  assert.strictEqual(realMoveIn(answered('9 months')), null,  'the dead format is not a value');
  assert.strictEqual(realMoveIn({ move_in_timeline: 'fall_semester' }), null, 'unstamped is a leftover');
  assert.strictEqual(realMoveIn(null), null);
  assert.strictEqual(hasRealMoveIn(answered('fall_semester')), true);
  assert.strictEqual(hasRealMoveIn(answered('flexible')), false);
});

test('moveInConflict: the whole matrix, mirroring the app', () => {
  // haveniq-app constants/moveIn.ts moveInCompatible(), transcribed. This file
  // is a deliberate mirror of that one, the way lib/pairAgreement.js mirrors
  // utils/pairFingerprint. A change there is a change here.
  const isConcrete = t => !!t && t !== 'flexible';
  const appCompatible = (a, b) => {
    if (!isConcrete(a) || !isConcrete(b)) return true;
    if (a === b) return true;
    const soon = new Set(['this_month', '1-3_months']);
    return soon.has(a) && soon.has(b);
  };
  let pairs = 0;
  for (const a of MOVE_IN_VALUES) {
    for (const b of MOVE_IN_VALUES) {
      pairs++;
      assert.strictEqual(
        moveInConflict(answered(a), answered(b)), !appCompatible(a, b),
        `server and app disagree on ${a} vs ${b}`);
    }
  }
  assert.strictEqual(pairs, 25);
});

test('moveInConflict: the pairs that actually cost a lease', () => {
  assert.strictEqual(moveInConflict(answered('this_month'), answered('fall_semester')), true);
  assert.strictEqual(moveInConflict(answered('spring_semester'), answered('fall_semester')), true);
  // One window: "this month" and "within three months" overlap.
  assert.strictEqual(moveInConflict(answered('this_month'), answered('1-3_months')), false);
  assert.strictEqual(moveInConflict(answered('fall_semester'), answered('fall_semester')), false);
});

test('moveInConflict fails OPEN on anything that is not a real answer', () => {
  // The pool is about thirty per campus. Excluding on a value nobody typed is
  // how you empty a feed, and the column is full of values nobody typed.
  const far = answered('fall_semester');
  assert.strictEqual(moveInConflict(answered('flexible'), far), false);
  assert.strictEqual(moveInConflict({ move_in_timeline: 'this_month' }, far), false, 'unstamped');
  assert.strictEqual(moveInConflict({ move_in_timeline: null, move_in_set_at: null }, far), false);
  assert.strictEqual(moveInConflict({}, far), false);
  assert.strictEqual(moveInConflict(answered('garbage'), far), false);
  assert.strictEqual(moveInConflict(answered('12 months'), far), false, 'the old dead format');
});


// ── combined ─────────────────────────────────────────────────────────────
test('isViable: viable unless a hard conflict, with reason', () => {
  assert.deepStrictEqual(isViable({}, {}), { viable: true, reason: null });
  assert.deepStrictEqual(
    isViable({ budget_min: 500, budget_max: 700 }, { budget_min: 1800, budget_max: 2500 }),
    { viable: false, reason: 'budget' });
  assert.deepStrictEqual(
    isViable({ move_in_timeline: 'this_month', move_in_set_at: 'x' },
             { move_in_timeline: 'fall_semester', move_in_set_at: 'x' }),
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
