// Tests for the regularized weight-learning core (Phase 2/3). Pure math — no
// DB. Covers labeling, per-question agreement correlation, the shrink formula,
// the proposal (ready / not-ready / thin-cohort inertness), per-school
// shrink-toward-global, and anomaly flags. node --test.
const test = require('node:test');
const assert = require('node:assert');
const wl = require('./weightLearning');

// ── labelPair: ground-truth definition ─────────────────────────────────────
test('labelPair: met + positive retention → worked', () => {
  assert.equal(wl.labelPair([
    { stage: 'meet48', answer: 'yes' },
    { stage: 'day30', rating: 5 },
  ]), 'worked');
  // met_in_person/lease_signed are unilateral-fine — no corroboration infra
  // exists for them, unlike moved_in_together (see the next block).
  assert.equal(wl.labelPair([
    { outcome: 'met_in_person' },
    { stage: 'day60', answer: 'yes' },
  ]), 'worked');
});

// moved_in_together is the one MET_OUTCOME with a real corroboration path
// (roommateVouches.js's bothMovedInTogether + the nudge in matchOutcomes.js)
// — it should NOT be able to label a pair "worked" on one person's word
// alone, since that person's own retention check-ins could ALSO be entirely
// self-generated (scheduleMoveIn only fires for whoever tapped "we moved
// in"). Two distinct reporterIds is what makes it count.
test('labelPair: a UNILATERAL moved_in_together claim alone does not count as "met"', () => {
  assert.equal(wl.labelPair([
    { outcome: 'moved_in_together', reporterId: 'user-a' },
    { stage: 'day60', answer: 'yes' },
  ]), null, 'one person\'s claim + their own retention check-in is not enough');
  // Two rows, but from the SAME reporter (a resubmission/duplicate) — still
  // only one distinct person, still not mutual.
  assert.equal(wl.labelPair([
    { outcome: 'moved_in_together', reporterId: 'user-a' },
    { outcome: 'moved_in_together', reporterId: 'user-a' },
    { stage: 'day60', answer: 'yes' },
  ]), null);
});

test('labelPair: a MUTUALLY confirmed moved_in_together (two distinct reporters) + retention → worked', () => {
  assert.equal(wl.labelPair([
    { outcome: 'moved_in_together', reporterId: 'user-a' },
    { outcome: 'moved_in_together', reporterId: 'user-b' },
    { stage: 'day60', answer: 'yes' },
  ]), 'worked');
});

test('labelPair: reporterId can also come from the details blob, same as stage/answer/rating', () => {
  assert.equal(wl.labelPair([
    { details: { outcome: 'moved_in_together', reporterId: 'user-a' }, outcome: 'moved_in_together' },
    { details: { outcome: 'moved_in_together', reporterId: 'user-b' }, outcome: 'moved_in_together' },
    { stage: 'day60', answer: 'yes' },
  ]), 'worked');
});

test('labelPair: decided_not_to_continue or rating<=2 → failed (failure wins)', () => {
  assert.equal(wl.labelPair([{ outcome: 'decided_not_to_continue' }]), 'failed');
  assert.equal(wl.labelPair([{ stage: 'day30', rating: 2 }]), 'failed');
  // Met + good early rating but later ended → still failed.
  assert.equal(wl.labelPair([
    { stage: 'meet48', answer: 'yes' },
    { stage: 'day30', rating: 5 },
    { outcome: 'ended_roommate_relationship' },
  ]), 'failed');
});

test('labelPair: met but no retention yet, or nothing → null (too-early)', () => {
  assert.equal(wl.labelPair([{ stage: 'meet48', answer: 'yes' }]), null);
  assert.equal(wl.labelPair([{ stage: 'meet48', answer: 'notyet' }]), null);
  assert.equal(wl.labelPair([]), null);
});

test('labelPair: reads stage/answer/rating from a details blob too', () => {
  assert.equal(wl.labelPair([
    { details: { stage: 'meet48', answer: 'yes' } },
    { details: { stage: 'day90', rating: 4 } },
  ]), 'worked');
});

// ── agreement + point-biserial ──────────────────────────────────────────────
test('agreement: identical=1, max distance=0, respects option count', () => {
  assert.equal(wl.agreement(2, 2, 4), 1);
  assert.equal(wl.agreement(0, 3, 4), 0);
  assert.equal(wl.agreement(0, 1, 2), 0);   // 2-option question
  assert.equal(wl.agreement(1, 2, 4), 1 - 1 / 3);
});

test('pointBiserial: perfect positive correlation ≈ 1, needs both classes', () => {
  const r = wl.pointBiserial([
    { x: 1, y: 1 }, { x: 0.9, y: 1 }, { x: 0.1, y: 0 }, { x: 0, y: 0 },
  ]);
  assert.ok(r > 0.9, `expected strong positive, got ${r}`);
  // One class only / no variance → null (honest "no signal", not 0).
  assert.equal(wl.pointBiserial([{ x: 1, y: 1 }, { x: 0.5, y: 1 }]), null);
  assert.equal(wl.pointBiserial([{ x: 0.5, y: 1 }, { x: 0.5, y: 0 }]), null);
});

// ── regularize: the shrink formula ─────────────────────────────────────────
test('regularize: n=0 → pure prior; k=0 → pure data; n=k → midpoint', () => {
  assert.equal(wl.regularize(100, 40, 0, 200), 40);       // no data → prior
  assert.equal(wl.regularize(100, 40, 50, 0), 100);       // k=0 → data
  assert.equal(wl.regularize(100, 40, 200, 200), 70);     // n=k → equal blend
});

// ── propose: readiness + inertness ──────────────────────────────────────────
const PRIOR = { 50: 45, 49: 35, 14: 35 };
const OPTS = { 14: 2 };

function synthPairs(n, workedFrac) {
  // Build n decided pairs where agreement on Q50 tracks the outcome (so Q50
  // shows a positive coefficient), Q49/Q14 are noise.
  const pairs = [];
  const answers = {};
  for (let i = 0; i < n; i++) {
    const worked = i < Math.round(n * workedFrac);
    const aId = `a${i}`, bId = `b${i}`;
    // worked pairs agree on Q50 (same index), failed pairs differ maximally.
    answers[aId] = { 50: 0, 49: i % 4, 14: i % 2 };
    answers[bId] = { 50: worked ? 0 : 3, 49: (i + 1) % 4, 14: (i + 1) % 2 };
    pairs.push({ label: worked ? 'worked' : 'failed', aId, bId });
  }
  return { pairs, answers };
}

test('propose: below MIN_N_GLOBAL → ready:false, never actionable', () => {
  const { pairs, answers } = synthPairs(40, 0.6);
  const p = wl.propose({ labeledPairs: pairs, answersByUser: answers, priorWeights: PRIOR, optionCounts: OPTS });
  assert.equal(p.ready, false);
  assert.equal(p.decided, 40);
  assert.equal(p.scope, 'global');
  // Proposed weights exist (illustrative) but caller must not apply when !ready.
  assert.ok(p.proposedWeights[50] >= 0);
});

test('propose: thin sample stays CLOSE to the prior (regularization bites)', () => {
  const { pairs, answers } = synthPairs(20, 0.5);
  const p = wl.propose({ labeledPairs: pairs, answersByUser: answers, priorWeights: PRIOR, optionCounts: OPTS });
  // n=20, k=200 → alpha≈0.09, so proposed ≈ prior. Q50 barely moves.
  assert.ok(Math.abs(p.proposedWeights[50] - 45) <= 5, `Q50=${p.proposedWeights[50]} should hug prior 45`);
});

test('propose: at readiness, a predictive question is the top signal', () => {
  const { pairs, answers } = synthPairs(320, 0.6);
  const p = wl.propose({ labeledPairs: pairs, answersByUser: answers, priorWeights: PRIOR, optionCounts: OPTS });
  assert.equal(p.ready, true);
  assert.equal(p.signals[0].qid, 50);          // Q50 agreement predicted success
  assert.ok(p.signals[0].coefficient > 0);
  assert.ok(p.proposedWeights[50] >= 45);      // earns weight (up or equal)
});

test('propose (per-school): shrinks toward the GLOBAL weights, lower gate', () => {
  const globalWeights = { 50: 60, 49: 20, 14: 35 };  // pretend global learned
  const { pairs, answers } = synthPairs(160, 0.6);
  const p = wl.propose({
    labeledPairs: pairs, answersByUser: answers, priorWeights: globalWeights,
    optionCounts: OPTS, scope: { school: 'CSUF' },
  });
  assert.equal(p.ready, true);                 // >= MIN_N_SCHOOL (150)
  assert.equal(p.minN, wl.MIN_N_SCHOOL);
  assert.ok(p.method.includes('GLOBAL'));
  // Below the school gate → not ready.
  const thin = wl.propose({
    labeledPairs: synthPairs(100, 0.6).pairs, answersByUser: synthPairs(100, 0.6).answers,
    priorWeights: globalWeights, optionCounts: OPTS, scope: { school: 'CSUF' },
  });
  assert.equal(thin.ready, false);
});

test('detectAnomalies: big move on a thin per-question sample is flagged', () => {
  const signals = [
    { qid: 50, current: 45, proposedWeight: 80, pairN: 10 },  // +78% on n=10 → flag
    { qid: 49, current: 35, proposedWeight: 36, pairN: 400 }, // tiny move → fine
  ];
  const flags = wl.detectAnomalies(signals);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].qid, 50);
});

test('weightFingerprint: stable + order-independent', () => {
  assert.equal(wl.weightFingerprint({ 50: 45, 14: 35 }), wl.weightFingerprint({ 14: 35, 50: 45 }));
  assert.notEqual(wl.weightFingerprint({ 50: 45 }), wl.weightFingerprint({ 50: 46 }));
});
