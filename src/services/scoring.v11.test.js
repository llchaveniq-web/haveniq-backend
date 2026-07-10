'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  calculateCompatibility, CATEGORY_WEIGHTS_V11, COMMUNICATION_COMPETENCE,
} = require('./scoring');

const calc = (a, b, v11) => calculateCompatibility(a, b, { v11 });

// A full answer map — every scored question at option 1 by default, so the
// non-communication categories are IDENTICAL between two users unless overridden
// (isolates the communication class in the ordering tests).
const ALL = [14, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 60, 62, 63, 65, 66, 67, 68];
const user = (overrides = {}) => { const m = {}; for (const id of ALL) m[id] = 1; return { ...m, ...overrides }; };
// Best / worst COMPETENCE option per communication question (from the derived map).
const COMM_BEST  = { 14: 1, 60: 0, 62: 2, 63: 0 };
const COMM_WORST = { 14: 0, 60: 3, 62: 0, 63: 3 };

test('v11 category weights honor the evidence tiers (comm HIGHEST ≥ lifestyle ≥ control ≥ nervous)', () => {
  const w = CATEGORY_WEIGHTS_V11;
  assert.ok(w.communication >= w.lifestyle, 'communication is highest');
  assert.ok(w.lifestyle >= w.control);
  assert.ok(w.control >= w.nervous);
  assert.ok(w.communication > 0 && w.nervous > 0);
});

test('v11 adequacy: double-low < mixed < double-high, and symmetric in argument order', () => {
  const doubleHigh = calc(user(COMM_BEST),  user(COMM_BEST),  true).finalPct;
  const doubleLow  = calc(user(COMM_WORST), user(COMM_WORST), true).finalPct;
  const mixedAB    = calc(user(COMM_BEST),  user(COMM_WORST), true).finalPct;
  const mixedBA    = calc(user(COMM_WORST), user(COMM_BEST),  true).finalPct;

  assert.ok(doubleLow < mixedAB, `double-low (${doubleLow}) < mixed (${mixedAB})`);
  assert.ok(mixedAB < doubleHigh, `mixed (${mixedAB}) < double-high (${doubleHigh})`);
  assert.strictEqual(mixedAB, mixedBA, 'adequacy is symmetric in (a,b)');
});

test('maxScore-only-when-both-answered invariant holds under BOTH flags', () => {
  for (const v11 of [false, true]) {
    // A answers two lifestyle Qs, B only one; the unshared Q (49) must NOT accrue.
    const shared = calc({ 50: 0, 49: 0 }, { 50: 0 }, v11).finalPct;
    const onlyShared = calc({ 50: 0 }, { 50: 0 }, v11).finalPct;
    assert.strictEqual(shared, onlyShared, `v11=${v11}: A's unshared answer changed the score`);
    // No shared answers at all ⇒ 0 (nothing to compare, no claim).
    assert.strictEqual(calc({ 50: 0 }, { 49: 0 }, v11).finalPct, 0, `v11=${v11}: disjoint pair scores 0`);
  }
});

test('flag toggles communication (similarity→adequacy) but leaves similarity categories identical', () => {
  // Identical answers, both at the WORST communication options.
  const a = user(COMM_WORST), b = user(COMM_WORST);
  const off = calc(a, b, false);   // v10: communication scored by SIMILARITY
  const on  = calc(a, b, true);    // v11: communication scored by ADEQUACY

  // Two avoidant communicators are IDENTICAL → similarity says ~perfect; adequacy
  // says ~worst. This is the whole point of the two-class model.
  assert.ok(off.breakdown.communication > on.breakdown.communication + 20,
    `off comm (${off.breakdown.communication}) should far exceed on comm (${on.breakdown.communication})`);

  // The similarity categories must be untouched by the flag (same answers, same
  // similarity scoring in both v10 and v11).
  assert.strictEqual(off.breakdown.lifestyle, on.breakdown.lifestyle, 'lifestyle unchanged by flag');
  assert.strictEqual(off.breakdown.control,   on.breakdown.control,   'control unchanged by flag');
  assert.strictEqual(off.breakdown.nervous,   on.breakdown.nervous,   'nervous unchanged by flag');
});

test('every communication question has a competence ordering (none fell back to similarity)', () => {
  for (const qid of [14, 60, 62, 63]) {
    assert.ok(Array.isArray(COMMUNICATION_COMPETENCE[qid]), `Q${qid} has a competence map`);
    assert.ok(COMMUNICATION_COMPETENCE[qid].every(v => typeof v === 'number' && v >= 0 && v <= 1));
  }
});
