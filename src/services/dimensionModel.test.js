// Tests for the deep-matching #2 outcome plumbing. Pure helpers only — the DB
// functions lazy-require pool, so importing this needs no `pg`. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { labelOutcome, buildDimensionRecords, PRIOR_DIRECTIONS } = require('./dimensionModel');

test('labelOutcome: moved in and stayed = success', () => {
  assert.equal(labelOutcome({ moved_in_at: '2026-01-01' }), true);
});

test('labelOutcome: failure signals win over a move-in (moved in, then room change)', () => {
  assert.equal(labelOutcome({ moved_in_at: '2026-01-01', room_change_at: '2026-03-01' }), false);
  assert.equal(labelOutcome({ blocked_at: '2026-02-01' }), false);
  assert.equal(labelOutcome({ ghosted_at: '2026-02-01' }), false);
});

test('labelOutcome: no terminal outcome yet = null (not a training example)', () => {
  assert.equal(labelOutcome({ connected_at: '2026-01-01', matched_at: '2026-01-02' }), null);
  assert.equal(labelOutcome({}), null);
  assert.equal(labelOutcome(null), null);
});

test('buildDimensionRecords: only labeled rows, only known dims, only finite pairs', () => {
  const rows = [
    // success, has Q57 + Q50
    { moved_in_at: 'x', features: { q: { 57: [0, 1], 50: [0.3, 0.3] } } },
    // failure, has Q57
    { room_change_at: 'x', features: { q: { 57: [0.5, 0.5] } } },
    // no outcome yet → excluded entirely
    { connected_at: 'x', features: { q: { 57: [0, 0] } } },
    // labeled but malformed/unknown features → skipped gracefully
    { moved_in_at: 'x', features: { q: { 57: ['nan', 1], 999: [0, 1] } } },
  ];
  const perDim = buildDimensionRecords(rows);
  assert.equal(perDim[57].length, 2, 'two labeled, finite Q57 pairs');
  // Records now carry the #6 trajectory fields (0 when no drift was snapshotted).
  assert.deepEqual(perDim[57][0], { a: 0, b: 1, success: true, conv: 0, vA: 0, vB: 0 });
  assert.deepEqual(perDim[57][1], { a: 0.5, b: 0.5, success: false, conv: 0, vA: 0, vB: 0 });
  assert.equal(perDim[50].length, 1);
  assert.ok(!('999' in perDim), 'unknown dimension is never tracked');
});

test('PRIOR_DIRECTIONS: only chore/boundaries allow complementarity; cleanliness allows directional', () => {
  assert.deepEqual(PRIOR_DIRECTIONS[57].allowedTypes, ['complementarity']);
  assert.deepEqual(PRIOR_DIRECTIONS[62].allowedTypes, ['complementarity']);
  assert.deepEqual(PRIOR_DIRECTIONS[50].allowedTypes, ['directional']);
  // Sleep / substances / hosting / repair are similarity-only (no flips).
  for (const qid of [49, 51, 48, 52, 54, 14, 60, 63, 56, 53]) {
    assert.deepEqual(PRIOR_DIRECTIONS[qid].allowedTypes, [], `qid ${qid} must be similarity-only`);
  }
});
