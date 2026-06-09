// Tests for the compatibility scoring engine — the heart of HavenIQ matching.
// Pure functions, no DB. Run with `npm test` (node --test).
const test = require('node:test');
const assert = require('node:assert');
const {
  calculateCompatibility,
  generateWhyMatched,
  calculateGroupCompatibility,
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
