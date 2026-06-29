// Tests for the compatibility scoring engine — the heart of HavenIQ matching.
// Pure functions, no DB. Run with `npm test` (node --test).
//
// v8 (2026-06-24): lifestyle-first reweight. Scored set is now the 14 ids:
//   lifestyle  50,49,48,53,55,54,52,51
//   conflict   14,57,60,62,63
//   money      56
// Abstract-personality / equity-risk ids (1,3,9,17,22,25,29,31,32,34,35,37,
// 40,45,58,59,61,15) are REMOVED — a pair differing only on those scores as if
// they agree. Hard zeroes replaced by dealbreaker CAPS (ceilings).
const test = require('node:test');
const assert = require('node:assert');
const {
  calculateCompatibility,
  generateWhyMatched,
  calculateGroupCompatibility,
  topFrictionTopic,
  diffScore,
} = require('./scoring');

// A 12-id identical baseline that clears the confidence floor (>=10 answered →
// conf 1.0) and triggers no caps (51 both Never, 54/52 both aligned). Spread of
// values keeps the Set size > 2 so confidence isn't throttled.
const AGREE = { 50: 1, 49: 2, 48: 1, 53: 2, 55: 1, 54: 0, 52: 1, 51: 0, 14: 0, 57: 1, 60: 1, 62: 2, 63: 1, 56: 2 };

test('identical answers score higher than opposite answers', () => {
  const same = calculateCompatibility(AGREE, { ...AGREE });
  const opp  = calculateCompatibility(AGREE, { 50: 3, 49: 3, 48: 3, 53: 3, 55: 3, 54: 0, 52: 1, 51: 0, 14: 1, 57: 3, 60: 3, 62: 3, 63: 3, 56: 3 });
  assert.ok(same.finalPct > opp.finalPct, `same(${same.finalPct}) should beat opposite(${opp.finalPct})`);
});

test('identical answers across the scored set read as near-perfect', () => {
  const r = calculateCompatibility(AGREE, { ...AGREE });
  assert.ok(r.finalPct >= 95, `identical should be ~100, got ${r.finalPct}`);
});

test('REMOVED questions no longer affect scoring (differ on them, still ~100)', () => {
  // Identical on every SCORED question, opposite on removed ones (1,25,58,35,45).
  const a = { ...AGREE, 1: 0, 25: 0, 58: 0, 35: 0, 45: 0 };
  const b = { ...AGREE, 1: 3, 25: 3, 58: 3, 35: 3, 45: 3 };
  const r = calculateCompatibility(a, b);
  assert.ok(r.finalPct >= 95, `removed-only differences must be ignored, got ${r.finalPct}`);
});

test('a pair sharing ONLY removed questions cannot be scored → 0', () => {
  const r = calculateCompatibility({ 1: 0, 25: 0 }, { 1: 0, 25: 0 });
  assert.equal(r.finalPct, 0);
});

test('newly-weighted conflict questions (62/63) still move the score', () => {
  const same = calculateCompatibility({ 62: 0, 63: 0, 14: 0 }, { 62: 0, 63: 0, 14: 0 });
  const diff = calculateCompatibility({ 62: 0, 63: 0, 14: 0 }, { 62: 3, 63: 3, 14: 1 });
  assert.ok(same.finalPct > diff.finalPct, 'Q62/63/14 must affect the score');
});

// ── Dealbreaker caps replace the old hard/soft blocks ───────────────────────

test('cap: non-smoker x smoker is capped (~35), NOT a hard zero', () => {
  // Identical on everything except Q51 (Never vs Regularly): base would be ~99,
  // the smoke cap must pull it down to <= 35 — and it is NOT a hard block.
  const a = { ...AGREE, 51: 0 };
  const b = { ...AGREE, 51: 3 };
  const r = calculateCompatibility(a, b);
  assert.equal(r.isHardBlocked, false, 'v8 uses caps, not hard zeroes');
  assert.ok(r.finalPct <= 35, `smoke mismatch should cap <= 35, got ${r.finalPct}`);
  assert.equal(r.capReason, 'smoking');
});

test('cap: non-smoker x occasional-smoker (0 vs 2) also caps at 35', () => {
  const r = calculateCompatibility({ ...AGREE, 51: 0 }, { ...AGREE, 51: 2 });
  assert.ok(r.finalPct <= 35, `got ${r.finalPct}`);
});

test('cap: alcohol opposite-ends caps <= 55 and flags soft-block', () => {
  const r = calculateCompatibility({ ...AGREE, 54: 0 }, { ...AGREE, 54: 3 });
  assert.ok(r.finalPct <= 55, `alcohol mismatch should cap <= 55, got ${r.finalPct}`);
  assert.equal(r.isSoftBlocked, true);
});

test('cap: overnight-partner opposite-ends caps <= 55 and flags soft-block', () => {
  const r = calculateCompatibility({ ...AGREE, 52: 0 }, { ...AGREE, 52: 3 });
  assert.ok(r.finalPct <= 55, `overnight mismatch should cap <= 55, got ${r.finalPct}`);
  assert.equal(r.isSoftBlocked, true);
});

test('no pair is ever hard-blocked in v8 (caps, not zeroes)', () => {
  const r = calculateCompatibility({ 51: 0 }, { 51: 3 });
  assert.equal(r.isHardBlocked, false);
});

// ── Breakdown reflects the new category set ─────────────────────────────────

test('breakdown exposes lifestyle + communication, and NOT removed categories', () => {
  const r = calculateCompatibility(AGREE, { ...AGREE });
  assert.ok('lifestyle' in r.breakdown, 'lifestyle category present');
  assert.ok('communication' in r.breakdown, 'communication category present');
  assert.ok(!('personality' in r.breakdown), 'personality category removed');
  assert.ok(!('shadow' in r.breakdown), 'shadow category removed');
  assert.ok(!('attachment' in r.breakdown), 'attachment category removed');
});

// ── Partial-completion fairness (progressive profiling) ─────────────────────

test('partial: a question only one user answered is ignored, not penalizing', () => {
  // Both answered the scored set identically; A also answered Q53, B did not on
  // one extra — the unshared answer must not drag the pair down.
  const a = { ...AGREE };
  const b = { ...AGREE }; delete b[56];          // B skipped one optional
  const r = calculateCompatibility(a, b);
  assert.ok(r.finalPct >= 95, `shared-identical partial should be ~100, got ${r.finalPct}`);
});

// ── Ranking quality: monotonic decrease as disagreement grows ───────────────

test('ranking quality: score decreases monotonically as disagreement grows', () => {
  // Anchor opposite on two non-cap 4-opt lifestyle items (48/55) to sit off the
  // calibration clamp, then add full disagreement on 60/62/63 step by step.
  const A = { 48: 0, 55: 0, 50: 0, 49: 0, 53: 0, 57: 0, 14: 0, 60: 0, 62: 0, 63: 0 };
  const score = (extra) => calculateCompatibility(A, { 48: 3, 55: 3, 50: 0, 49: 0, 53: 0, 57: 0, 14: 0, ...extra }).finalPct;
  const none = score({ 60: 0, 62: 0, 63: 0 });
  const some = score({ 60: 3, 62: 0, 63: 0 });
  const more = score({ 60: 3, 62: 3, 63: 0 });
  const most = score({ 60: 3, 62: 3, 63: 3 });
  assert.ok(none > some && some > more && more > most,
    `expected strict monotonic decrease, got ${none} > ${some} > ${more} > ${most}`);
});

// ── diffScore option-count normalization (unchanged in v8) ──────────────────

test('diffScore: 4-option v9 curve (100/85/50/0)', () => {
  assert.equal(diffScore(100, 0, 4), 100);
  assert.equal(diffScore(100, 1, 4), 85);   // v9: one notch = 15% off (was 40%)
  assert.equal(diffScore(100, 2, 4), 50);
  assert.equal(diffScore(100, 3, 4), 0);
});

test('diffScore: a full 2-option (binary) disagreement scores 0, not 60', () => {
  assert.equal(diffScore(100, 0, 2), 100);
  assert.equal(diffScore(100, 1, 2), 0);
});

test('diffScore: 3- and 5-option scales normalize onto the 0..3 v9 curve', () => {
  assert.equal(diffScore(100, 1, 3), 68);   // v9
  assert.equal(diffScore(100, 2, 3), 0);
  assert.equal(diffScore(100, 4, 5), 0);
  assert.equal(diffScore(100, 1, 5), 89);   // v9
});

test('diffScore: missing option count defaults to 4-option behavior', () => {
  assert.equal(diffScore(100, 1, undefined), 85);   // v9
});

test('Q14 (contempt) is the binary item: full clash scores below a 4-opt one-step gap', () => {
  // Single-question maps so the result reflects that one question (not clamped
  // at the 99 ceiling by an otherwise-identical baseline).
  const binaryClash = calculateCompatibility({ 14: 0 }, { 14: 1 }); // 2-opt, max gap
  const quadOneStep = calculateCompatibility({ 50: 0 }, { 50: 1 }); // 4-opt, one step
  assert.ok(binaryClash.finalPct < quadOneStep.finalPct,
    `binary clash (${binaryClash.finalPct}) should be below a 4-opt one-step gap (${quadOneStep.finalPct})`);
});

// ── flatten robustness ──────────────────────────────────────────────────────

test('numeric-string answers are coerced, not dropped', () => {
  const nums = calculateCompatibility(AGREE, { ...AGREE });
  const asStr = {}; for (const [k, v] of Object.entries(AGREE)) asStr[k] = String(v);
  const strs = calculateCompatibility(asStr, { ...AGREE });
  assert.equal(strs.finalPct, nums.finalPct, 'string-encoded answers must score identically');
});

test('option index 0 survives coercion (finiteness, not truthiness)', () => {
  const r = calculateCompatibility({ ...AGREE, 50: 0 }, { ...AGREE, 50: '0' });
  assert.ok(r.finalPct >= 95, `identical (0 vs "0") should be ~100, got ${r.finalPct}`);
});

// ── dealbreaker amplification ───────────────────────────────────────────────

test('dealbreaker amplification runs and returns a valid score', () => {
  const r = calculateCompatibility(
    { ...AGREE, 50: 0 },
    { ...AGREE, 50: 2 },
    { dealbreakers: ['cleanliness'] },
  );
  assert.ok(r.finalPct >= 0 && r.finalPct <= 100);
});

// ── group compatibility ─────────────────────────────────────────────────────

test('group compatibility averages pairwise and returns a valid score', () => {
  const g = calculateGroupCompatibility([AGREE], [{ ...AGREE }]);
  assert.ok(g.finalPct >= 0 && g.finalPct <= 100);
  assert.equal(g.isHardBlocked, false);
});

test('group compatibility returns null when a group is empty', () => {
  assert.equal(calculateGroupCompatibility([], [AGREE]), null);
});

// ── why-matched copy ────────────────────────────────────────────────────────

test('generateWhyMatched returns a non-empty string', () => {
  const r = calculateCompatibility(AGREE, { ...AGREE });
  const why = generateWhyMatched(r.breakdown, 92);
  assert.equal(typeof why, 'string');
  assert.ok(why.length > 10);
});

test('finalPct is always clamped to 0..100', () => {
  const r = calculateCompatibility(AGREE, { ...AGREE });
  assert.ok(r.finalPct >= 0 && r.finalPct <= 100);
});

// ── Part 2: behavioral-validation layer (honesty gate) ──────────────────────

test('validation: no signal → multiplier 1.0 and finalPct == preValidationPct', () => {
  // Neither user has a validation_score → the multiplier must be a neutral 1.0
  // and the headline must be unchanged (no invented "validated" lift).
  const r = calculateCompatibility(AGREE, { ...AGREE });
  assert.equal(r.validationMultiplier, 1, 'no signal must stay neutral');
  assert.equal(r.finalPct, r.preValidationPct, 'neutral mult leaves the score untouched');
  assert.ok(r.preValidationPct >= 0 && r.preValidationPct <= 100);
});

test('validation: one-sided signal is ignored (honesty gate) → still 1.0', () => {
  // Only user A has a validation_score. A one-sided signal must NOT move the
  // score — a wrong "validated" badge is trust fraud.
  const r = calculateCompatibility(AGREE, { ...AGREE }, { validationA: 0.9 });
  assert.equal(r.validationMultiplier, 1);
  assert.equal(r.finalPct, r.preValidationPct);
});

test('validation: both-sided real signal moves finalPct off preValidationPct', () => {
  // Both users validated high → multiplier > 1, finalPct lifts above the pre %
  // (clamped to the [0.925, 1.075] band). Use a mid-range pair so neither the
  // 100 ceiling nor a cap masks the lift.
  const A = { 48: 0, 55: 0, 50: 1, 49: 1 };
  const B = { 48: 1, 55: 1, 50: 1, 49: 1 };
  const neutral = calculateCompatibility(A, B);
  const lifted  = calculateCompatibility(A, B, { validationA: 1, validationB: 1 });
  assert.ok(lifted.validationMultiplier > 1, 'both-high → lift');
  assert.ok(lifted.finalPct >= neutral.finalPct, 'lift never lowers the score');
  assert.ok(lifted.validationMultiplier <= 1.08, 'clamped to band (≈1.075, 2-dp rounded)');
});

test('validation: out-of-range scores are treated as no signal', () => {
  // A bogus validation_score (>1, <0, NaN) must be rejected as "no signal",
  // not clamped into a fake lift.
  const r = calculateCompatibility(AGREE, { ...AGREE }, { validationA: 5, validationB: -2 });
  assert.equal(r.validationMultiplier, 1);
});

// ── Deep-matching #2: basis layer cold-start + certified shapes ──────────────

test('cold-start: no dimensionModels is bit-for-bit identical to today', () => {
  // The basis layer must change NOTHING without a certified shape. Compare a
  // spread of pairs with no opts vs an empty/garbage model map.
  const pairs = [
    [AGREE, { ...AGREE }],
    [AGREE, { 50: 3, 49: 0, 48: 2, 53: 1, 55: 3, 54: 0, 52: 1, 51: 0, 14: 1, 57: 3, 60: 2, 62: 0, 63: 3, 56: 1 }],
    [{ 50: 0, 49: 1, 57: 2 }, { 50: 2, 49: 3, 57: 0 }],
  ];
  for (const [a, b] of pairs) {
    const base = calculateCompatibility(a, b);
    const empty = calculateCompatibility(a, b, { dimensionModels: {} });
    const garbage = calculateCompatibility(a, b, { dimensionModels: { 57: { certified: false } } });
    assert.equal(empty.finalPct, base.finalPct, 'empty model must not move the score');
    assert.equal(garbage.finalPct, base.finalPct, 'uncertified model must not move the score');
    assert.deepEqual(empty.breakdown, base.breakdown);
    assert.deepEqual(empty.complementaryDims, []);
  }
});

test('cold-start: complementaryDims is empty and whyMatched copy is unchanged', () => {
  const r = calculateCompatibility(AGREE, { ...AGREE });
  assert.deepEqual(r.complementaryDims, []);
  const why = generateWhyMatched(r.breakdown, r.finalPct, r.complementaryDims);
  assert.ok(!/balance each other/.test(why), 'no balance copy without a certified shape');
});

// A synthetic certified-complementary shape for Q57 (chore). β_dist > 0 so
// far-apart answers score WELL; baseline is the fixed cold-start prior.
const CHORE_COMPLEMENT = {
  57: {
    certified: true,
    type: 'complementarity',
    baseline: { intercept: 0, coef: { dist: -1, mean: 0, min: 0, max: 0, prod: 0 } },
    basis:    { intercept: -1.5, coef: { dist: 3.5, mean: 0, min: 0, max: 0, prod: 0 } },
  },
};

test('certified complementary shape lifts a far-apart pair and emits the dim', () => {
  // Identical except Q57 is opposite (initiator + responder). Today that gap
  // costs points; the certified shape rewards it.
  const a = { ...AGREE, 57: 0 };
  const b = { ...AGREE, 57: 3 };
  const today      = calculateCompatibility(a, b);
  const complement = calculateCompatibility(a, b, { dimensionModels: CHORE_COMPLEMENT });
  assert.ok(complement.finalPct >= today.finalPct,
    `complementary shape should not lower a far-apart pair (${complement.finalPct} vs ${today.finalPct})`);
  assert.deepEqual(complement.complementaryDims, [{ qid: 57, label: 'chore' }]);
});

test('certified shape does NOT fire balance copy for a two-of-a-kind pair', () => {
  // Same shape, but the pair AGREES on Q57 — difference isn't the reason, so no
  // complementarity callout (the gap is below COMPLEMENT_MIN_GAP).
  const r = calculateCompatibility({ ...AGREE, 57: 1 }, { ...AGREE, 57: 1 }, { dimensionModels: CHORE_COMPLEMENT });
  assert.deepEqual(r.complementaryDims, []);
});

test('whyMatched leads with the balance phrase when a dim is complementary', () => {
  const why = generateWhyMatched({ lifestyle: 90, communication: 80 }, 88, [{ qid: 57, label: 'chore' }]);
  assert.ok(/your chore styles balance each other/i.test(why), why);
});

// ── Deep-matching #4: topFrictionTopic (suites) ──────────────────────────────

test('topFrictionTopic picks the largest weighted-gap dimension', () => {
  // Q49 (sleep, 35pts) opposite ends vs a small Q50 (cleanliness) gap → sleep.
  const topic = topFrictionTopic({ 49: 0, 50: 0 }, { 49: 3, 50: 1 });
  assert.equal(topic, 'sleep schedules');
});

test('topFrictionTopic is null when the pair shares no scored answers / agrees', () => {
  assert.equal(topFrictionTopic({ ...AGREE }, { ...AGREE }), null); // identical → no gap
  assert.equal(topFrictionTopic({}, {}), null);                     // nothing shared
});

// ── Deep-matching #5: LLM text-insight constructs ────────────────────────────

// A certified construct where reading SIMILAR predicts success (positive basis).
const DIRECT_SHAPE = {
  directness: {
    certified: true,
    baseline: { intercept: -0.5, coef: {} },
    basis: { intercept: 2, coef: { dist: -4, mean: 0, min: 0, max: 0, prod: 0, conv: 0 } },
  },
};

test('cold-start: LLM features present but no certified models is bit-for-bit today', () => {
  const today = calculateCompatibility(AGREE, { ...AGREE });
  const withFeatures = calculateCompatibility(AGREE, { ...AGREE }, {
    llmFeaturesA: { directness: 0.9 }, llmFeaturesB: { directness: 0.85 },
  });
  assert.equal(withFeatures.finalPct, today.finalPct);
  assert.deepEqual(withFeatures.textInsightDims, []);
});

test('uncertified LLM model does not move the score', () => {
  const today = calculateCompatibility(AGREE, { ...AGREE });
  const r = calculateCompatibility(AGREE, { ...AGREE }, {
    llmModels: { directness: { certified: false, basis: { coef: {} }, baseline: { coef: {} } } },
    llmFeaturesA: { directness: 0.9 }, llmFeaturesB: { directness: 0.85 },
  });
  assert.equal(r.finalPct, today.finalPct);
});

test('a certified construct on a similar pair adds a bounded lift + emits the note', () => {
  const a = { 48: 0, 55: 0, 50: 1, 49: 1 }, b = { 48: 1, 55: 1, 50: 1, 49: 1 };
  const base = calculateCompatibility(a, b);
  const lifted = calculateCompatibility(a, b, {
    llmModels: DIRECT_SHAPE,
    llmFeaturesA: { directness: 0.9 }, llmFeaturesB: { directness: 0.85 }, // similar + high
  });
  assert.ok(lifted.finalPct >= base.finalPct, `${lifted.finalPct} vs ${base.finalPct}`);
  assert.ok(lifted.finalPct - base.finalPct <= 15, 'LLM adjustment is bounded to ±15pp');
  assert.deepEqual(lifted.textInsightDims, [{ construct: 'directness', note: 'you both write like direct, upfront communicators' }]);
  const why = generateWhyMatched(lifted.breakdown, lifted.finalPct, lifted.complementaryDims, lifted.convergingDims, lifted.textInsightDims);
  assert.ok(/direct, upfront communicators/i.test(why), why);
});

test('a certified construct needs BOTH users\' features (one-sided → no effect)', () => {
  const today = calculateCompatibility(AGREE, { ...AGREE });
  const r = calculateCompatibility(AGREE, { ...AGREE }, {
    llmModels: DIRECT_SHAPE, llmFeaturesA: { directness: 0.9 }, // B missing
  });
  assert.equal(r.finalPct, today.finalPct);
  assert.deepEqual(r.textInsightDims, []);
});

// ── Deep-matching #6: trajectory (projection + convergence) ──────────────────

const RELIABLE = (velocity) => ({ velocity, trend: 'changed', sampleSize: 10 });

test('cold-start: drift present but no models is bit-for-bit identical to today', () => {
  // Even with strong drift, without a certified shape projection can't apply and
  // convergence is unused → scoring must equal the no-drift score exactly.
  const a = { ...AGREE, 49: 0 };
  const b = { ...AGREE, 49: 3 };
  const today = calculateCompatibility(a, b);
  const withDrift = calculateCompatibility(a, b, {
    driftA: { 49: RELIABLE(-1) }, driftB: { 49: RELIABLE(1) }, horizonDays: 90,
  });
  assert.equal(withDrift.finalPct, today.finalPct);
  assert.deepEqual(withDrift.convergingDims, []);
});

test('cold-start: a stable/low-sample trend never projects (no-op)', () => {
  const a = { ...AGREE, 49: 0 }, b = { ...AGREE, 49: 3 };
  const proj = {
    49: { certified: true, type: 'similarity', project: true,
          baseline: { intercept: 0, coef: { dist: -1 } },
          basis: { intercept: 0, coef: { dist: -1, mean: 0, min: 0, max: 0, prod: 0, conv: 0 } } },
  };
  const stable = calculateCompatibility(a, b, {
    dimensionModels: proj, driftA: { 49: { velocity: 5, trend: 'stable', sampleSize: 10 } }, horizonDays: 90,
  });
  const none = calculateCompatibility(a, b, { dimensionModels: proj });
  assert.equal(stable.finalPct, none.finalPct); // unreliable drift ⇒ no projection
});

test('projection: a certified project shape moves a far pair toward agreement, clamped & in range', () => {
  // A and B are 3 apart on Q49; both trending toward the middle. Projection
  // should raise the pair's score, and finalPct stays a valid 0..100.
  const a = { ...AGREE, 49: 0 }, b = { ...AGREE, 49: 3 };
  const proj = {
    49: { certified: true, type: 'similarity', project: true,
          baseline: { intercept: 0, coef: { dist: -1 } },
          basis: { intercept: 0, coef: { dist: -1, mean: 0, min: 0, max: 0, prod: 0, conv: 0 } } },
  };
  const snapshot = calculateCompatibility(a, b, { dimensionModels: proj });
  const projected = calculateCompatibility(a, b, {
    dimensionModels: proj,
    driftA: { 49: RELIABLE(1) },   // 0 → trending up toward 3
    driftB: { 49: RELIABLE(-1) },  // 3 → trending down toward 0
    horizonDays: 90,
  });
  assert.ok(projected.finalPct >= snapshot.finalPct, `${projected.finalPct} vs ${snapshot.finalPct}`);
  assert.ok(projected.finalPct >= 0 && projected.finalPct <= 100);
});

test('convergence: a shape that rewards conv + a closing pair emits convergingDims', () => {
  const a = { ...AGREE, 49: 0 }, b = { ...AGREE, 49: 3 };
  const convShape = {
    49: { certified: true, type: 'similarity', project: false,
          baseline: { intercept: 0, coef: { dist: -1 } },
          // conv weighted strongly positive → closing pairs score better.
          basis: { intercept: 0, coef: { dist: -1, mean: 0, min: 0, max: 0, prod: 0, conv: 2 } } },
  };
  const closing = calculateCompatibility(a, b, {
    dimensionModels: convShape,
    driftA: { 49: RELIABLE(1) },   // 0 climbing toward 3
    driftB: { 49: RELIABLE(-1) },  // 3 falling toward 0  → gap closing
    horizonDays: 90,
  });
  assert.deepEqual(closing.convergingDims, [{ qid: 49, label: 'sleep', note: 'your sleep schedules are converging' }]);
  const why = generateWhyMatched(closing.breakdown, closing.finalPct, closing.complementaryDims, closing.convergingDims);
  assert.ok(/sleep schedules are converging/i.test(why), why);
});

test('convergence: a widening pair does NOT emit convergingDims', () => {
  const a = { ...AGREE, 49: 0 }, b = { ...AGREE, 49: 3 };
  const convShape = {
    49: { certified: true, type: 'similarity', project: false,
          baseline: { intercept: 0, coef: { dist: -1 } },
          basis: { intercept: 0, coef: { dist: -1, mean: 0, min: 0, max: 0, prod: 0, conv: 2 } } },
  };
  const widening = calculateCompatibility(a, b, {
    dimensionModels: convShape,
    driftA: { 49: RELIABLE(-1) },  // 0 dropping below
    driftB: { 49: RELIABLE(1) },   // 3 rising further → widening
    horizonDays: 90,
  });
  assert.deepEqual(widening.convergingDims, []);
});
