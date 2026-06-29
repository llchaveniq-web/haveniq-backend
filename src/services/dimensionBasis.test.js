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
  fitProjectionGated,
  projectVal,
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

test('conv is a back-compatible 6th basis feature (defaults 0)', () => {
  const f = expandPair(0.8, 0.2);
  assert.equal(f.conv, 0);                          // default when not supplied
  assert.equal(expandPair(0.8, 0.2, 0.5).conv, 0.5);
  assert.equal(distOnlyPrior(1).coef.conv, 0);      // prior never weights conv
});

test('projectVal clamps a normalized value to [0,1] and no-ops on zero velocity', () => {
  assert.equal(projectVal(0.5, 0, 90), 0.5);
  assert.equal(projectVal(0.5, 0.1, 30), 0.6);      // +0.1/30d × 1 month
  assert.equal(projectVal(0.9, 0.1, 90), 1);        // clamps up
  assert.equal(projectVal(0.1, -0.1, 90), 0);       // clamps down
});

test('projection gate: thin data keeps projection OFF', () => {
  const recs = [{ a: 0.2, b: 0.8, success: true, vA: 0.1, vB: -0.1 }];
  assert.equal(fitProjectionGated(recs).project, false);
});

test('projection gate: turns ON when projected values predict outcomes the snapshot can not', () => {
  // Outcome is driven by where the pair is HEADING. Crucially the velocities are
  // INDEPENDENT of the snapshot answers, so the current gap can't predict the
  // outcome (two pairs with the same |a−b| but different drift land differently);
  // only the projected gap can. The gate must turn projection on.
  const recs = [];
  for (let i = 0; i < 200; i++) {
    const a = ((i * 41) % 100) / 100;
    const b = ((i * 73 + 13) % 100) / 100;
    const vA = (((i * 29 + 5) % 21) - 10) / 100;   // −0.10..0.10, independent of a,b
    const vB = (((i * 17 + 3) % 21) - 10) / 100;
    const aProj = projectVal(a, vA, 90), bProj = projectVal(b, vB, 90); // +3×velocity
    const success = Math.abs(aProj - bProj) < 0.3;  // labeled by the PROJECTED gap
    recs.push({ a, b, success, conv: 0, vA, vB });
  }
  const g = fitProjectionGated(recs, { minImprovement: 0.01 });
  assert.equal(g.project, true, g.reason);
  assert.ok(g.improvement >= 0.01);
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
