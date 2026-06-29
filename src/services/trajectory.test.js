// Tests for the deep-matching #6 trajectory helpers. Pure, no DB. node --test.
const test = require('node:test');
const assert = require('node:assert');
const {
  reliability, effectiveVelocity, projectIndex, convergence, horizonFromMoveIn,
} = require('./trajectory');

const drift = (velocity, trend, sampleSize) => ({ velocity, trend, sampleSize });

test('reliability: 0 below 3 samples or on a stable/unknown trend', () => {
  assert.equal(reliability(drift(1, 'changed', 2)), 0);
  assert.equal(reliability(drift(1, 'stable', 10)), 0);
  assert.equal(reliability(drift(1, null, 10)), 0);
  assert.equal(reliability(null), 0);
});

test('reliability: grows with samples and trusts "changed" over "shifting"', () => {
  assert.ok(reliability(drift(1, 'changed', 10)) > reliability(drift(1, 'changed', 3)));
  assert.ok(reliability(drift(1, 'changed', 10)) > reliability(drift(1, 'shifting', 10)));
  assert.equal(reliability(drift(1, 'changed', 10)), 1);          // full at 10 + changed
  assert.equal(reliability(drift(1, 'shifting', 3)), 0.5 * 0.6);  // minimum credible signal
});

test('effectiveVelocity: app velocity scaled by confidence; 0 when unreliable', () => {
  assert.equal(effectiveVelocity(drift(2, 'changed', 10)), 2);   // reliability 1
  assert.equal(effectiveVelocity(drift(2, 'stable', 10)), 0);    // not projectable
  assert.equal(effectiveVelocity(drift(2, 'shifting', 2)), 0);   // too few samples
});

test('projectIndex: no/again unreliable drift returns the index unchanged (cold-start)', () => {
  assert.equal(projectIndex(2, undefined, 90, 3), 2);
  assert.equal(projectIndex(2, drift(5, 'stable', 10), 90, 3), 2);
  assert.equal(projectIndex(2, drift(5, 'changed', 2), 90, 3), 2);
});

test('projectIndex: projects forward and clamps to [0, maxIdx]', () => {
  // velocity −1/30d, horizon 30d ⇒ −1 step.
  assert.equal(projectIndex(2, drift(-1, 'changed', 10), 30, 3), 1);
  // horizon 90d ⇒ −3 ⇒ would be −1, clamps to 0.
  assert.equal(projectIndex(2, drift(-1, 'changed', 10), 90, 3), 0);
  // upward clamp to maxIdx.
  assert.equal(projectIndex(2, drift(5, 'changed', 10), 90, 3), 3);
});

test('convergence: 0 at cold-start, positive when closing, negative when widening', () => {
  assert.equal(convergence(2, 0, undefined, undefined, 3), 0);            // no drift
  // a above b, a moving DOWN toward b ⇒ closing ⇒ positive.
  assert.ok(convergence(2, 0, drift(-1, 'changed', 10), undefined, 3) > 0);
  // a above b, a moving UP away ⇒ widening ⇒ negative.
  assert.ok(convergence(2, 0, drift(1, 'changed', 10), undefined, 3) < 0);
  // both moving the same way at the same rate ⇒ gap unchanged ⇒ 0.
  assert.equal(convergence(2, 0, drift(1, 'changed', 10), drift(1, 'changed', 10), 3), 0);
});

test('convergence is normalized and clamped to [-1, 1]', () => {
  const c = convergence(3, 0, drift(-50, 'changed', 10), drift(50, 'changed', 10), 3);
  assert.ok(c >= -1 && c <= 1);
  assert.ok(c > 0); // both racing toward the middle ⇒ strongly closing
});

test('horizonFromMoveIn: parses month timelines, else falls back to 90', () => {
  assert.equal(horizonFromMoveIn('1 month'), 30);
  assert.equal(horizonFromMoveIn('2 months'), 60);
  assert.equal(horizonFromMoveIn('This semester'), 90);
  assert.equal(horizonFromMoveIn(null), 90);
  assert.equal(horizonFromMoveIn(undefined), 90);
});
