// Tests for the compatibility scoring engine — the heart of HavenIQ matching.
// Pure functions, no DB. Run with `npm test` (node --test).
const test = require('node:test');
const assert = require('node:assert');
const {
  calculateCompatibility,
  generateWhyMatched,
  calculateGroupCompatibility,
  diffScore,
} = require('./scoring');

test('identical answers score higher than opposite answers', () => {
  const a = { 1: 0, 14: 0, 50: 1, 49: 1 };
  const same = calculateCompatibility(a, { ...a });
  const opp = calculateCompatibility(a, { 1: 3, 14: 1, 50: 3, 49: 0 });
  assert.ok(
    same.finalPct > opp.finalPct,
    `same(${same.finalPct}) should beat opposite(${opp.finalPct})`,
  );
});

test('Q61 / Q62 / Q63 are wired into scoring (they move the result)', () => {
  const same = calculateCompatibility({ 61: 0, 62: 0, 63: 0 }, { 61: 0, 62: 0, 63: 0 });
  const diff = calculateCompatibility({ 61: 0, 62: 0, 63: 0 }, { 61: 3, 62: 3, 63: 3 });
  assert.ok(same.finalPct > diff.finalPct, 'newly-wired questions must affect the score');
});

test('hard block: substances Never vs Regularly → 0%', () => {
  const r = calculateCompatibility({ 51: 0 }, { 51: 3 });
  assert.equal(r.isHardBlocked, true);
  assert.equal(r.finalPct, 0);
});

test('hard block: extreme bedtime gap → 0%', () => {
  const r = calculateCompatibility({ 49: 0 }, { 49: 3 });
  assert.equal(r.isHardBlocked, true);
  assert.equal(r.finalPct, 0);
});

test('soft block: cleanliness mismatch sets isSoftBlocked', () => {
  const r = calculateCompatibility({ 50: 0 }, { 50: 3 });
  assert.equal(r.isSoftBlocked, true);
});

test('breakdown exposes personality + communication categories', () => {
  const r = calculateCompatibility({ 15: 0, 14: 0 }, { 15: 0, 14: 0 });
  assert.ok('personality' in r.breakdown, 'personality category present');
  assert.ok('communication' in r.breakdown, 'communication category present');
});

test('dealbreaker amplification runs and returns a valid score', () => {
  const r = calculateCompatibility(
    { 50: 0, 49: 1 },
    { 50: 2, 49: 1 },
    { dealbreakers: ['cleanliness'] },
  );
  assert.ok(r.finalPct >= 0 && r.finalPct <= 100);
});

test('finalPct is always clamped to 0..100', () => {
  const r = calculateCompatibility({ 1: 0, 14: 0 }, { 1: 0, 14: 0 });
  assert.ok(r.finalPct >= 0 && r.finalPct <= 100);
});

test('generateWhyMatched returns a non-empty string', () => {
  const r = calculateCompatibility({ 1: 0 }, { 1: 0 });
  const why = generateWhyMatched(r.breakdown, 92);
  assert.equal(typeof why, 'string');
  assert.ok(why.length > 10);
});

test('group compatibility hard-blocks if any cross-pair hard-blocks', () => {
  const g = calculateGroupCompatibility([{ 51: 0 }], [{ 51: 3 }]);
  assert.equal(g.isHardBlocked, true);
  assert.equal(g.finalPct, 0);
});

test('group compatibility returns null when a group is empty', () => {
  assert.equal(calculateGroupCompatibility([], [{ 1: 0 }]), null);
});

// ── Progressive profiling: partial-completion fairness (2026-06-09) ──────────
// Regression guard for the "score only questions BOTH answered" fix that makes
// the 12-core unlock viable. Before the fix these deflated badly (~41%).

test('partial: identical shared answers score ~100; a question only one user answered is ignored', () => {
  // Both answered Q1 identically; A also answered Q53, B did not. The
  // unanswered Q53 must NOT drag the pair down.
  const r = calculateCompatibility({ 1: 0, 53: 0 }, { 1: 0 });
  assert.ok(r.finalPct >= 95, `shared-identical partial should be ~100, got ${r.finalPct}`);
});

test('partial: identical 12-core answers score ~100 (not deflated by skipped optional)', () => {
  const core = { 49: 1, 51: 0, 50: 1, 54: 0, 1: 0, 14: 0, 25: 1, 45: 1, 57: 0, 58: 3, 60: 0, 35: 1 };
  const r = calculateCompatibility(core, { ...core });
  assert.ok(r.finalPct >= 95, `identical core should be ~100, got ${r.finalPct}`);
});

test('partial: no shared answered questions → 0 (cannot score strangers)', () => {
  const r = calculateCompatibility({ 1: 0 }, { 14: 0 });
  assert.equal(r.finalPct, 0);
});

// ── v7 question additions (2026-06-09) ──────────────────────────────────────

test('new v7 questions (52 partners / 53 study / 55 food) are wired into scoring', () => {
  const same = calculateCompatibility({ 52: 0, 53: 0, 55: 0 }, { 52: 0, 53: 0, 55: 0 });
  const diff = calculateCompatibility({ 52: 0, 53: 0, 55: 0 }, { 52: 3, 53: 3, 55: 3 });
  assert.ok(same.finalPct > diff.finalPct, 'Q52/53/55 must affect the score');
});

test('soft block: overnight-partner (Q52) mismatch sets isSoftBlocked', () => {
  const r = calculateCompatibility({ 52: 0 }, { 52: 3 });
  assert.equal(r.isSoftBlocked, true);
});

test('soft block: alcohol comfort (Q54) mismatch sets isSoftBlocked', () => {
  const r = calculateCompatibility({ 54: 0 }, { 54: 3 });
  assert.equal(r.isSoftBlocked, true);
});

// ── diffScore option-count normalization (2026-06-19) ────────────────────────
// Fix: a FULL disagreement should cost the same regardless of how many options a
// question has. 4-option questions must be UNCHANGED.

test('diffScore: 4-option curve is unchanged (100/60/20/0)', () => {
  assert.equal(diffScore(100, 0, 4), 100);
  assert.equal(diffScore(100, 1, 4), 60);
  assert.equal(diffScore(100, 2, 4), 20);
  assert.equal(diffScore(100, 3, 4), 0);
});

test('diffScore: a full 2-option (binary) disagreement now scores 0, not 60', () => {
  assert.equal(diffScore(100, 0, 2), 100); // agree
  assert.equal(diffScore(100, 1, 2), 0);   // total clash → full mismatch (was 60)
});

test('diffScore: 3- and 5-option scales normalize onto the 0..3 curve', () => {
  assert.equal(diffScore(100, 1, 3), 40);  // one apart of two steps
  assert.equal(diffScore(100, 2, 3), 0);   // full clash
  assert.equal(diffScore(100, 4, 5), 0);   // full clash
  assert.equal(diffScore(100, 1, 5), 70);  // one of four steps
});

test('diffScore: missing option count defaults to 4-option behavior', () => {
  assert.equal(diffScore(100, 1, undefined), 60);
});

test('ranking quality: score decreases monotonically as disagreement grows', () => {
  // The one property that matters most for a matching feed: correct ORDERING.
  // Anchor with two fully-opposite 4-opt questions (Q1/Q3) to keep scores off
  // the 99 calibration clamp, then add disagreement on Q25/Q35/Q45 step by step
  // and confirm the score strictly drops each time. None of these are block Qs.
  const score = (extra) => calculateCompatibility(
    { 1: 0, 3: 0, 25: 0, 35: 0, 45: 0 },
    { 1: 3, 3: 3, ...extra },
  ).finalPct;
  const none = score({ 25: 0, 35: 0, 45: 0 }); // agree on the rest
  const some = score({ 25: 1, 35: 0, 45: 0 }); // one off
  const more = score({ 25: 1, 35: 1, 45: 0 }); // two off
  const most = score({ 25: 1, 35: 1, 45: 1 }); // three off
  assert.ok(
    none > some && some > more && more > most,
    `expected strict monotonic decrease, got ${none} > ${some} > ${more} > ${most}`,
  );
});

test('binary full clash (Q14, 2-opt) is now scored worse than a 4-opt one-step gap (Q1)', () => {
  // The inversion the fix targets: before, a total yes/no clash earned 60% —
  // as much as a mild 4-option gap. Now the binary clash scores strictly lower.
  const binaryClash = calculateCompatibility({ 14: 0 }, { 14: 1 }); // 2-opt, max gap
  const quadOneStep = calculateCompatibility({ 1: 0 },  { 1: 1 });  // 4-opt, small gap
  assert.ok(
    binaryClash.finalPct < quadOneStep.finalPct,
    `binary clash (${binaryClash.finalPct}) should score below a 4-opt one-step gap (${quadOneStep.finalPct})`,
  );
});

// ── flatten robustness: numeric-string answers must not be silently dropped ──

test('numeric-string answers are coerced, not dropped (would otherwise skew score)', () => {
  // Same answers, one side stored as strings — must score identical to numbers.
  const nums = calculateCompatibility({ 1: 0, 14: 0, 25: 1 }, { 1: 0, 14: 0, 25: 1 });
  const strs = calculateCompatibility({ 1: '0', 14: '0', 25: '1' }, { 1: 0, 14: 0, 25: 1 });
  assert.equal(strs.finalPct, nums.finalPct, 'string-encoded answers must score the same as numbers');
});

test('string answers still trigger hard blocks (Q51 "0" vs "3")', () => {
  const r = calculateCompatibility({ 51: '0' }, { 51: '3' });
  assert.equal(r.isHardBlocked, true);
  assert.equal(r.finalPct, 0);
});

test('option index 0 survives coercion (finiteness, not truthiness)', () => {
  // A bare 0 and "0" are valid answers; a buggy guard could drop them.
  const r = calculateCompatibility({ 1: 0 }, { 1: '0' });
  assert.ok(r.finalPct >= 95, `identical Q1 (0 vs "0") should be ~100, got ${r.finalPct}`);
});
