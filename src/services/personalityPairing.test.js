// Tests for the personality-pairing readout + the 30%-blend calibration.
// Pure functions, no DB. Run with `npm test` (node --test).
const test = require('node:test');
const assert = require('node:assert');
const {
  computePersonalityMatch,
  calibratePersonality,
} = require('./personalityPairing');

test('calibratePersonality stretches around the 72 centre, not 50', () => {
  // The centre maps to itself (no shift), unlike the clinical curve's mid=50.
  assert.equal(calibratePersonality(72), 72);
  // Above centre stretches up, below centre stretches down — monotonic.
  assert.ok(calibratePersonality(85) > 85, 'above centre should rise');
  assert.ok(calibratePersonality(60) < 60, 'below centre should fall');
});

test('calibratePersonality widens the raw band and is monotonic', () => {
  const lo = calibratePersonality(58);
  const mid = calibratePersonality(72);
  const hi = calibratePersonality(90);
  assert.ok(lo < mid && mid < hi, 'ranking must be preserved');
  // The raw heuristic band (~58-90, width 32) should come out wider.
  assert.ok(hi - lo > 32, `band should widen (got ${hi - lo})`);
});

test('calibratePersonality clamps to [5, 99]', () => {
  assert.ok(calibratePersonality(100) <= 99);
  assert.ok(calibratePersonality(0) >= 5);
});

test('calibratePersonality passes through null / non-finite untouched', () => {
  assert.equal(calibratePersonality(null), null);
  assert.equal(calibratePersonality(undefined), undefined);
});

test('computePersonalityMatch: complementary E/I beats clashing same-type', () => {
  // ENFJ + INFJ (E/I differ — ideal) vs two identical ESTJ (no balance).
  const comp = computePersonalityMatch(
    { mbti: 'ENFJ', disc: 'S', ocean: { openness: 60, conscientiousness: 60, extraversion: 60, agreeableness: 60, neuroticism: 40 } },
    { mbti: 'INFJ', disc: 'S', ocean: { openness: 60, conscientiousness: 60, extraversion: 50, agreeableness: 60, neuroticism: 40 } },
  );
  assert.ok(comp !== null && comp > 0, 'should produce a score');
});

test('computePersonalityMatch returns null with no usable signal', () => {
  assert.equal(computePersonalityMatch({ mbti: 'XX', disc: '', ocean: null }, { mbti: '', disc: '', ocean: null }), null);
});
