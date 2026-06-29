// Tests for the Part 3 learning loop — the pure ridge fit and rank scoring.
// No DB: fitFromExamples / personalRankScore / uniformPrior are pure. Run with
// `npm test` (node --test).
const test = require('node:test');
const assert = require('node:assert');
const {
  CATEGORY_KEYS,
  uniformPrior,
  fitFromExamples,
  personalRankScore,
} = require('./decisionLearning');

// A breakdown with one category dialed to `hi` and the rest at `lo`.
const bd = (hiKey, hi, lo = 50) => {
  const o = {};
  for (const k of CATEGORY_KEYS) o[k] = k === hiKey ? hi : lo;
  return o;
};

test('uniformPrior sums to 1 and is equal across categories', () => {
  const p = uniformPrior();
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'prior must sum to 1');
  for (const k of CATEGORY_KEYS) assert.ok(Math.abs(p[k] - 1 / CATEGORY_KEYS.length) < 1e-9);
});

test('low sample → null (no model, feed order untouched)', () => {
  assert.equal(fitFromExamples([], []), null, 'no data → no model');
  assert.equal(fitFromExamples([bd('lifestyle', 90)], [bd('lifestyle', 10)]), null, '1v1 is too thin');
});

test('one-sided history → null (need both likes AND declines)', () => {
  const pos = Array.from({ length: 10 }, () => bd('lifestyle', 90));
  assert.equal(fitFromExamples(pos, []), null, 'all-likes can not contrast');
});

test('a real contrast lifts the predictive category above the prior', () => {
  // This user CONNECTS when lifestyle is high and DECLINES when it is low —
  // lifestyle should earn more weight than the uniform prior.
  const pos = Array.from({ length: 8 }, () => bd('lifestyle', 90));
  const neg = Array.from({ length: 8 }, () => bd('lifestyle', 10));
  const w = fitFromExamples(pos, neg);
  assert.ok(w, 'enough sample → a model');
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'weights must remain a proper distribution');
  assert.ok(w.lifestyle > uniformPrior().lifestyle, 'predictive category gains weight');
  assert.ok(w.communication < uniformPrior().communication, 'non-predictive categories give way');
});

test('weights are clamped — no single category can run away', () => {
  // Extreme, lopsided history. Even so, lifestyle must stay within the clamp
  // band (≤1.5× prior before renormalization) — it can not dominate the feed.
  const pos = Array.from({ length: 50 }, () => bd('lifestyle', 100, 0));
  const neg = Array.from({ length: 50 }, () => bd('lifestyle', 0, 100));
  const w = fitFromExamples(pos, neg);
  // 1.5× prior renormalized: ceiling share = 1.5 / (1.5 + (K-1)) for the others
  // at their own clamped values. A loose upper bound: never more than half.
  assert.ok(w.lifestyle <= 0.5, `clamped, got ${w.lifestyle}`);
});

test('personalRankScore weights the breakdown; falls back without a model', () => {
  const weights = uniformPrior();
  const breakdown = bd('lifestyle', 100, 0); // one cat 100, rest 0
  // Uniform weights → simple mean of the categories.
  const expected = 100 / CATEGORY_KEYS.length;
  assert.ok(Math.abs(personalRankScore(breakdown, weights, 0) - expected) < 1e-9);
  // No weights / no breakdown → fall back to the supplied compat score.
  assert.equal(personalRankScore(breakdown, null, 42), 42);
  assert.equal(personalRankScore(null, weights, 42), 42);
});

test('a learned model re-orders two rows by the user\'s real priority', () => {
  // User cares about communication. Row B is stronger on communication but
  // weaker overall; under the learned model it should outrank row A.
  const pos = Array.from({ length: 10 }, () => bd('communication', 95));
  const neg = Array.from({ length: 10 }, () => bd('communication', 15));
  const w = fitFromExamples(pos, neg);
  const rowA = { breakdown: bd('lifestyle', 90, 60), compat: 80 };     // high lifestyle
  const rowB = { breakdown: bd('communication', 90, 60), compat: 78 }; // high communication
  const sA = personalRankScore(rowA.breakdown, w, rowA.compat);
  const sB = personalRankScore(rowB.breakdown, w, rowB.compat);
  assert.ok(sB > sA, `communication-lover should rank B (${sB}) over A (${sA})`);
});
