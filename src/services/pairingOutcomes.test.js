// Tests for the serve-time feature snapshot (buildServeFeatures). Pure — no DB.
// The DB writers (recordPairingEvent / recordFeedImpressions) lazy-require pool,
// so importing this module needs no `pg`. Run with `npm test` (node --test).
const test = require('node:test');
const assert = require('node:assert');
const { buildServeFeatures } = require('./pairingOutcomes');

// Q14 is the only 2-option scored item (OPTION_COUNTS), everything else is
// 4-option → denominator 3. So a 4-opt index 0..3 maps to 0, .333, .667, 1.
test('normalizes both users per question onto [0,1] by option count', () => {
  const a = { 50: 0, 14: 0 };        // 4-opt idx0 → 0 ; 2-opt idx0 → 0
  const b = { 50: 3, 14: 1 };        // 4-opt idx3 → 1 ; 2-opt idx1 → 1
  const { q } = buildServeFeatures(a, b);
  assert.deepEqual(q[50], [0, 1]);
  assert.deepEqual(q[14], [0, 1]);   // binary item normalizes to the full range
});

test('mid options round to 3 decimals', () => {
  const { q } = buildServeFeatures({ 49: 1 }, { 49: 2 }); // 4-opt → 1/3, 2/3
  assert.deepEqual(q[49], [0.333, 0.667]);
});

test('only questions BOTH answered are included', () => {
  const { q } = buildServeFeatures({ 50: 1, 49: 2 }, { 50: 1 }); // B skipped 49
  assert.ok('50' in q, 'shared question present');
  assert.ok(!('49' in q), 'one-sided question omitted');
});

test('numeric-string answers are coerced, wire-shape objects unwrapped', () => {
  const a = { 50: '2', 49: { index: 1 } };
  const b = { 50: { value: 2 }, 49: '1' };
  const { q } = buildServeFeatures(a, b);
  assert.deepEqual(q[50], [0.667, 0.667]);
  assert.deepEqual(q[49], [0.333, 0.333]);
});

test('un-scored question ids never appear in the feature map', () => {
  // Q1 was removed from the scored set in v8 — it must not leak into features.
  const { q } = buildServeFeatures({ 1: 0, 50: 0 }, { 1: 3, 50: 0 });
  assert.ok(!('1' in q), 'removed question excluded');
  assert.ok('50' in q);
});

test('empty / missing answers yield an empty feature map (no fabrication)', () => {
  assert.deepEqual(buildServeFeatures(null, null), { q: {} });
  assert.deepEqual(buildServeFeatures({ 50: 1 }, null), { q: {} });
});
