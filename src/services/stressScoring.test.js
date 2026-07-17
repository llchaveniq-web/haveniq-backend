// Stress dimension (docs/specs/stress-response-dimension.md) — pure unit tests.
// Covers: the reclaim of ids 65/66/67 is a no-op, the clash matrix's marquee
// reads, pattern detection, and the lockstep inertness guarantee. node --test.
const test = require('node:test');
const assert = require('node:assert');
const {
  calculateCompatibility, scoreStress,
  STRESS_IDS, STRESS_STYLES, STRESS_CLASH, RECOVERY_CLASH, STRESS_PACTS,
  QUESTION_POINTS, CATEGORIES,
} = require('./scoring');

// A complete, ordinary answer set with NO stress answers (today's real users).
const BASE = { 50: 1, 49: 1, 48: 1, 53: 1, 55: 1, 54: 1, 52: 1, 51: 0, 14: 0, 57: 1, 60: 1, 62: 1, 63: 1, 56: 1 };
// Q65: 0 withdraw 1 reactive 2 pursue 3 suppress 4 control
// Q66: 0 solitude 1 co-regulate 2 parallel 3 sequenced
// Q67: 0 pursue 1 withdraw 2 accommodate 3 suppress

// ── The reclaim (ids 65/66/67 must leave the ORDINAL path entirely) ──
test('reclaim: 65/66/67 are gone from the ordinal scorer', () => {
  for (const qid of STRESS_IDS) {
    assert.equal(QUESTION_POINTS[qid], undefined, `qid ${qid} must not have ordinal points`);
    for (const [cat, { ids }] of Object.entries(CATEGORIES)) {
      assert.ok(!ids.includes(qid), `qid ${qid} must not be in ordinal CATEGORIES.${cat}`);
    }
  }
});

test('reclaim is a NO-OP: an existing pair scores identically with stress absent', () => {
  const a = calculateCompatibility(BASE, { ...BASE });
  // Same inputs must be stable, and no stress read may appear.
  assert.equal(a.underPressure, null);
  assert.equal(a.breakdown.stress, undefined);
  // The pair still scores on the same four categories it always did.
  assert.deepEqual(Object.keys(a.breakdown).sort(), ['communication', 'control', 'lifestyle', 'nervous']);
});

// ── Inertness (the lockstep guarantee) ──
test('inert: null unless BOTH users answered a stress item', () => {
  assert.equal(scoreStress({}, {}), null);
  assert.equal(scoreStress({ 65: 2 }, {}), null, 'one-sided must not score');
  assert.equal(scoreStress({}, { 65: 0 }), null);
  assert.ok(scoreStress({ 65: 2 }, { 65: 0 }), 'both answered ⇒ scores');
});

test('inert: calculateCompatibility exposes no underPressure without stress answers', () => {
  assert.equal(calculateCompatibility(BASE, { ...BASE }).underPressure, null);
});

// ── The marquee read ──
test('pursue × withdraw is the highest-friction coping pair (clash 5)', () => {
  assert.equal(STRESS_CLASH.pursue.withdraw, 5);
  const r = scoreStress({ 65: 2 }, { 65: 0 });   // pursue vs withdraw
  assert.equal(r.pattern, 'pursue_withdraw');
  assert.equal(r.score, 0, 'clash 5 ⇒ score 0 (highest risk)');
});

test('pursue_withdraw is detected on the in-conflict item too (Q67)', () => {
  const r = scoreStress({ 67: 0 }, { 67: 1 });   // pursue vs withdraw
  assert.equal(r.pattern, 'pursue_withdraw');
});

test('both_suppress — the quiet blowup', () => {
  const r = scoreStress({ 65: 3 }, { 65: 3 });
  assert.equal(r.pattern, 'both_suppress');
  assert.equal(r.score, 25, 'clash 4 ⇒ 25');
});

test('reactive × suppress', () => {
  const r = scoreStress({ 65: 1 }, { 65: 3 });
  assert.equal(r.pattern, 'reactive_suppress');
});

test('recovery mismatch — solitude × co-regulate', () => {
  assert.equal(RECOVERY_CLASH.solitude['co-regulate'], 5);
  const r = scoreStress({ 66: 0 }, { 66: 1 });
  assert.equal(r.pattern, 'recovery_mismatch');
});

test('complementary — low friction across all three ⇒ high score + tag', () => {
  // withdraw×control (2), sequenced×sequenced (1), withdraw×withdraw (2)
  const r = scoreStress({ 65: 0, 66: 3, 67: 1 }, { 65: 4, 66: 3, 67: 1 });
  assert.equal(r.score, 80);
  assert.equal(r.pattern, 'complementary');
});

// ── Invariants ──
test('symmetric: order of the pair never changes the score', () => {
  const A = { 65: 2, 66: 0, 67: 0 }, B = { 65: 0, 66: 1, 67: 1 };
  assert.equal(scoreStress(A, B).score, scoreStress(B, A).score);
  assert.equal(scoreStress(A, B).pattern, scoreStress(B, A).pattern);
});

test('the clash matrices are symmetric (a×b === b×a)', () => {
  for (const [a, row] of Object.entries(STRESS_CLASH))
    for (const [b, v] of Object.entries(row))
      assert.equal(v, STRESS_CLASH[b][a], `STRESS_CLASH ${a}×${b} !== ${b}×${a}`);
  for (const [a, row] of Object.entries(RECOVERY_CLASH))
    for (const [b, v] of Object.entries(row))
      assert.equal(v, RECOVERY_CLASH[b][a], `RECOVERY_CLASH ${a}×${b} !== ${b}×${a}`);
});

test('every style a question can emit has a row in its matrix', () => {
  for (const s of STRESS_STYLES[65]) assert.ok(STRESS_CLASH[s], `no clash row for coping style ${s}`);
  for (const s of STRESS_STYLES[67]) assert.ok(STRESS_CLASH[s], `no clash row for conflict style ${s}`);
  for (const s of STRESS_STYLES[66]) assert.ok(RECOVERY_CLASH[s], `no recovery row for ${s}`);
});

test('score is always 0-100 across every possible pairing', () => {
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) {
    const r = scoreStress({ 65: a }, { 65: b });
    assert.ok(r.score >= 0 && r.score <= 100, `65 ${a}x${b} ⇒ ${r.score}`);
  }
});

test('partial answers are renormalized, not penalized', () => {
  // Both answered only Q66, perfectly flexible ⇒ must not be dragged down by the
  // two unanswered items.
  const r = scoreStress({ 66: 3 }, { 66: 3 });
  assert.equal(r.score, 100);
});

// ── Payload contract (§4) ──
test('calculateCompatibility surfaces the §4 underPressure shape + breakdown row', () => {
  const A = { ...BASE, 65: 2, 66: 0, 67: 0 };
  const B = { ...BASE, 65: 0, 66: 1, 67: 1 };
  const r = calculateCompatibility(A, B);
  assert.ok(r.underPressure, 'present once both answered');
  assert.equal(typeof r.underPressure.score, 'number');
  assert.equal(r.underPressure.pattern, 'pursue_withdraw');
  assert.equal(typeof r.underPressure.pactSuggestion, 'string');
  assert.equal(r.underPressure.pactSuggestion, STRESS_PACTS.pursue_withdraw);
  assert.equal(typeof r.breakdown.stress, 'number', 'stress earns its own breakdown row');
});

test('every pattern has a pact suggestion (§4 pactSuggestion)', () => {
  for (const p of ['pursue_withdraw', 'both_suppress', 'reactive_suppress', 'recovery_mismatch', 'complementary'])
    assert.equal(typeof STRESS_PACTS[p], 'string', `missing pact for ${p}`);
});
