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

test('diffScore: 4-option curve is unchanged (100/60/20/0)', () => {
  assert.equal(diffScore(100, 0, 4), 100);
  assert.equal(diffScore(100, 1, 4), 60);
  assert.equal(diffScore(100, 2, 4), 20);
  assert.equal(diffScore(100, 3, 4), 0);
});

test('diffScore: a full 2-option (binary) disagreement scores 0, not 60', () => {
  assert.equal(diffScore(100, 0, 2), 100);
  assert.equal(diffScore(100, 1, 2), 0);
});

test('diffScore: 3- and 5-option scales normalize onto the 0..3 curve', () => {
  assert.equal(diffScore(100, 1, 3), 40);
  assert.equal(diffScore(100, 2, 3), 0);
  assert.equal(diffScore(100, 4, 5), 0);
  assert.equal(diffScore(100, 1, 5), 70);
});

test('diffScore: missing option count defaults to 4-option behavior', () => {
  assert.equal(diffScore(100, 1, undefined), 60);
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
