// Tests for the deep-matching #2 basis math + held-out gate. Pure, no DB.
// Mirrors app/utils/dimensionBasis.test.ts and adds the gate/AUC-recovery cases.
// Run with `npm test` (node --test).
const test = require('node:test');
const assert = require('node:assert');
const {
  expandPair,
  distOnlyPrior,
  classifyType,
  fitDimensionGated,
  displayDelta,
} = require('./dimensionBasis');

test('expandPair computes dist/mean/min/max/prod', () => {
  const f = expandPair(0.8, 0.2);
  assert.ok(Math.abs(f.dist - 0.6) < 1e-9);
  assert.ok(Math.abs(f.mean - 0.5) < 1e-9);
  assert.equal(f.min, 0.2);
  assert.equal(f.max, 0.8);
  assert.ok(Math.abs(f.prod - 0.16) < 1e-9);
});

test('distOnlyPrior puts NEGATIVE weight on dist, zero elsewhere', () => {
  const p = distOnlyPrior(1.5);
  assert.ok(p.coef.dist < 0);
  assert.equal(p.coef.mean, 0);
  assert.equal(p.coef.min, 0);
  assert.equal(p.coef.max, 0);
  assert.equal(p.coef.prod, 0);
});

test('classifyType reads the shape from coefficient signs', () => {
  assert.equal(classifyType({ dist: -1 }), 'similarity');
  assert.equal(classifyType({ dist: 1.2 }), 'complementarity');
  assert.equal(classifyType({ dist: -0.1, max: -1.5 }), 'directional');
});

test('displayDelta is 0 for an uncertified shape (cold-start no-op)', () => {
  const shape = fitDimensionGated([], { allowedTypes: ['complementarity'] });
  assert.equal(shape.certified, false);
  assert.equal(displayDelta(shape, 0.1, 0.9), 0);
});

// ── Deterministic worlds ────────────────────────────────────────────────────
function world(n, rule) {
  const recs = [];
  for (let i = 0; i < n; i++) {
    const a = ((i * 41) % 100) / 100;
    const b = ((i * 73 + 13) % 100) / 100;
    recs.push({ a, b, success: rule(a, b) });
  }
  return recs;
}

test('thin data never certifies (safe cold-start)', () => {
  const shape = fitDimensionGated(world(5, (a, b) => Math.abs(a - b) > 0.5), {
    allowedTypes: ['complementarity'],
  });
  assert.equal(shape.certified, false);
});

test('AUC recovery: a complementary dimension today scores ~chance-or-worse, the basis recovers it', () => {
  // success = FAR apart (opposite is good) — exactly what today's similarity
  // curve gets backwards. Mirrors dim_combination_sim (0.138 → 0.858).
  const shape = fitDimensionGated(world(200, (a, b) => Math.abs(a - b) > 0.5), {
    allowedTypes: ['complementarity'],
    minImprovement: 0.01,
  });
  assert.equal(shape.certified, true, shape.reason);
  assert.equal(shape.type, 'complementarity');
  assert.ok(shape.aucBaseline < 0.4, `today's curve should be poor on a complementary dim, got ${shape.aucBaseline}`);
  assert.ok(shape.auc > 0.8, `basis should recover it, got ${shape.auc}`);
});

test('a complementary fit is REJECTED when the dimension does not allow it', () => {
  // Same world, but this dimension is similarity-only (allowedTypes empty) — the
  // prior says thin data may not flip it. Must stay dist-only.
  const shape = fitDimensionGated(world(200, (a, b) => Math.abs(a - b) > 0.5), {
    allowedTypes: [],
    minImprovement: 0.01,
  });
  assert.equal(shape.certified, false);
  assert.equal(displayDelta(shape, 0.1, 0.9), 0);
});

test('a directional dimension certifies only when directional is allowed', () => {
  // success = the MESSIER side (max) is low — a level/asymmetric effect dist
  // can't see. Encodes "the tidier roommate eats the cost."
  const recs = world(200, (a, b) => Math.max(a, b) < 0.5);
  const allowed = fitDimensionGated(recs, { allowedTypes: ['directional'], minImprovement: 0.01 });
  assert.equal(allowed.certified, true, allowed.reason);
  assert.equal(allowed.type, 'directional');

  const blocked = fitDimensionGated(recs, { allowedTypes: ['complementarity'], minImprovement: 0.01 });
  assert.equal(blocked.certified, false); // directional shape not authorized here
});

test('a similarity-configured dimension (allowedTypes []) never flips, whatever the data', () => {
  // The production guard for similarity dims: with no authorized flip direction,
  // NO world can certify a shape — it always stays on today's dist-only curve.
  // (On noiseless toy data a flexible basis can overfit odd signs; allowedTypes
  // is what actually keeps a similarity dimension honest.)
  for (const rule of [
    (a, b) => Math.abs(a - b) < 0.3,   // genuine similarity
    (a, b) => Math.abs(a - b) > 0.5,   // would-be complementarity
    (a, b) => Math.max(a, b) < 0.5,    // would-be directional
  ]) {
    const shape = fitDimensionGated(world(200, rule), { allowedTypes: [], minImprovement: 0.01 });
    assert.equal(shape.certified, false, `allowedTypes [] must never certify (rule failed)`);
    assert.equal(displayDelta(shape, 0.1, 0.9), 0);
  }
});

test('certified complementary shape lifts a far-apart pair above two-of-a-kind', () => {
  const shape = fitDimensionGated(world(200, (a, b) => Math.abs(a - b) > 0.5), {
    allowedTypes: ['complementarity'],
  });
  const far  = displayDelta(shape, 0.1, 0.9); // opposites
  const same = displayDelta(shape, 0.5, 0.5); // two-of-a-kind
  assert.ok(far > 0, `opposites should be rewarded, got ${far}`);
  assert.ok(far > same, `opposites (${far}) should beat two-of-a-kind (${same})`);
});
