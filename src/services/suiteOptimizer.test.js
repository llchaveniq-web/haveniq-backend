// Tests for the deep-matching #4 suite optimizer. Pure (pairEval injected),
// no DB. The product invariant: a suite is scored by its WEAKEST pair and we
// optimize the MAXIMIN — nobody is sacrificed for a good average. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { buildSuites } = require('./suiteOptimizer');

// Five members A..E.
const members = ['A', 'B', 'C', 'D', 'E'].map((u, i) => ({
  userId: u, firstName: u, lastInitial: u, schoolYear: 'Sophomore',
}));
const ix = { A: 0, B: 1, C: 2, D: 3, E: 4 };

// Build a pairEval from an explicit score table keyed "XY" (X<Y by letter), with
// an optional set of invalid pairs.
function evalFrom(scores, invalid = new Set()) {
  return (i, j) => {
    const a = members[i].userId, b = members[j].userId;
    const key = a < b ? a + b : b + a;
    if (invalid.has(key)) return { score: 0, valid: false };
    return { score: scores[key] ?? 50, valid: true, topFrictionTopic: 'sleep schedules' };
  };
}

test('suiteScore is the MIN of internal pair scores, not the mean', () => {
  // Group A,B,C with pairs 90/90/30 → mean 70 but min 30.
  const scores = { AB: 90, AC: 90, BC: 30, AD: 10, AE: 10, BD: 10, BE: 10, CD: 10, CE: 10, DE: 10 };
  const [suite] = buildSuites(members, { pairEval: evalFrom(scores), sizes: [3], count: 1 });
  assert.equal(suite.suiteScore, 30, 'scored by the weakest pair, not the average');
  // weakestPair is the 30 pair (B,C).
  assert.equal(suite.weakestPair.score, 30);
  assert.deepEqual([suite.weakestPair.a, suite.weakestPair.b].sort(), ['B', 'C']);
});

test('maximin beats a higher-average grouping that hides one bad pair', () => {
  // {A,B,C}: 80/80/80 → min 80, avg 80.
  // {A,B,D}: 100/100/20 → min 20, avg ~73 (higher max, but one miserable pair).
  // The optimizer must pick {A,B,C} (maximin), never the higher-max group.
  const scores = {
    AB: 100, AC: 80, BC: 80,          // C is the steady-80 friend
    AD: 100, BD: 20,                  // D clicks with A but clashes with B
    CD: 80, AE: 50, BE: 50, CE: 50, DE: 50,
  };
  const [suite] = buildSuites(members, { pairEval: evalFrom(scores), sizes: [3], count: 1 });
  assert.deepEqual(suite.members.map(m => m.userId).sort(), ['A', 'B', 'C']);
  assert.equal(suite.suiteScore, 80);
});

test('a hard-blocked pair invalidates every suite that contains it', () => {
  // A,B,C all score 95 with each other EXCEPT B,C are hard-blocked. The only
  // size-3 group over {A,B,C,D,E} that avoids the B,C edge must be chosen, and
  // no returned suite may contain both B and C.
  const scores = { AB: 95, AC: 95, BC: 95, AD: 70, BD: 70, CD: 70, AE: 70, BE: 70, CE: 70, DE: 70 };
  const suites = buildSuites(members, { pairEval: evalFrom(scores, new Set(['BC'])), sizes: [3], count: 10 });
  for (const s of suites) {
    const u = s.members.map(m => m.userId);
    assert.ok(!(u.includes('B') && u.includes('C')), 'no suite may contain the hard-blocked pair');
  }
});

test('emits the exact Suite / SuiteMember / SuitePair field names', () => {
  const [suite] = buildSuites(members, { pairEval: evalFrom({}), sizes: [3], count: 1 });
  assert.deepEqual(Object.keys(suite).sort(), ['members', 'pairs', 'suiteScore', 'weakestPair']);
  const m = suite.members[0];
  assert.ok('userId' in m && 'firstName' in m && 'lastInitial' in m);
  const p = suite.pairs[0];
  assert.ok('a' in p && 'b' in p && 'score' in p);
  assert.equal(typeof p.topFrictionTopic, 'string');
  // pairs covers every internal pair of a 3-group (3 pairs); weakestPair is one.
  assert.equal(suite.pairs.length, 3);
});

test('size param controls how many suites are returned (not the apartment size)', () => {
  const three = buildSuites(members, { pairEval: evalFrom({}), sizes: [3], count: 3 });
  assert.ok(three.length <= 3);
  // default group size still 3 members per suite.
  assert.equal(three[0].members.length, 3);
});

test('empty / too-small pool → [] (never padded, never fabricated)', () => {
  assert.deepEqual(buildSuites([], { pairEval: evalFrom({}), sizes: [3], count: 1 }), []);
  assert.deepEqual(buildSuites(members.slice(0, 2), { pairEval: evalFrom({}), sizes: [3], count: 1 }), []);
});

test('no VALID group can be formed → [] (every group has a blocked pair)', () => {
  // With only 3 members and one blocked pair, the single size-3 group is invalid.
  const three = members.slice(0, 3);
  const pe = (i, j) => {
    const a = three[i].userId, b = three[j].userId;
    const key = a < b ? a + b : b + a;
    if (key === 'BC') return { score: 0, valid: false };
    return { score: 80, valid: true };
  };
  assert.deepEqual(buildSuites(three, { pairEval: pe, sizes: [3], count: 1 }), []);
});

test('anchored: every returned suite includes the requester', () => {
  // C is the requester. The globally-best suite would be {A,B,D} (excluding C),
  // but anchored mode must only ever return suites containing C.
  const scores = { AB: 99, AD: 99, BD: 99, AC: 70, BC: 70, CD: 70, AE: 60, BE: 60, CE: 60, DE: 60 };
  const suites = buildSuites(members, { pairEval: evalFrom(scores), sizes: [3], count: 5, anchorUserId: 'C' });
  assert.ok(suites.length > 0, 'should still find anchored suites');
  for (const s of suites) {
    assert.ok(s.members.map(m => m.userId).includes('C'), 'every suite must contain the requester');
  }
});

test('anchored: requester not in the pool → [] (never a suite they are not in)', () => {
  const suites = buildSuites(members, { pairEval: evalFrom({}), sizes: [3], count: 3, anchorUserId: 'NOT_IN_POOL' });
  assert.deepEqual(suites, []);
});

test('results are deterministic — same input, same output', () => {
  const scores = { AB: 88, AC: 77, BC: 66, AD: 90, BD: 55, CD: 91, AE: 60, BE: 70, CE: 80, DE: 84 };
  const run = () => buildSuites(members, { pairEval: evalFrom(scores), sizes: [3, 4], count: 3 });
  assert.deepEqual(run(), run());
});
