// ═══════════════════════════════════════════════════════════════════════════
//  Regularized weight-learning — Phase 2/3 of the outcome-learning loop.
//
//  The STATISTICS do the learning here; no LLM decides who is compatible. From
//  real roommate outcomes we measure, per scored quiz question, whether the two
//  roommates AGREEING on that question (small answer-index distance) correlates
//  with the pairing actually WORKING — a point-biserial coefficient. Questions
//  whose agreement predicts success earn weight; questions that predict nothing
//  lose it. Re-derived weights are then SHRUNK toward the current expert prior
//  in proportion to how thin the sample is, so a small (possibly biased) early
//  cohort can never swing a weight wildly.
//
//  This module is PURE (no DB, no I/O) so the risky learning math is unit-
//  tested directly. It only ever PROPOSES; committing a proposal to the live
//  model stays human-gated (see routes/weightLearning.js + weightProposalStore).
//
//  Inert until data accrues: below the readiness threshold `ready:false` and
//  callers must not apply anything — scoring stays on today's expert weights,
//  bit-for-bit.
// ═══════════════════════════════════════════════════════════════════════════

// Regularization constant (the "k" in the shrink formula). At n = k the data
// and the prior get equal say; below it the prior dominates. ~200 keeps ~a few
// hundred outcomes from over-fitting while still letting real signal through.
const K_SHRINK = 200;
// Readiness gates: a proposal is only ACTIONABLE at/above these decided-pair
// counts. Global (Phase 2) needs a few hundred; a per-school (Phase 3) layer
// needs its own ~150 before it may deviate from the global weights.
const MIN_N_GLOBAL = 300;
const MIN_N_SCHOOL = 150;

const RETENTION_STAGES = new Set(['day30', 'day60', 'day90', 'month6']);
const MET_OUTCOMES     = new Set(['met_in_person', 'moved_in_together', 'lease_signed']);
const FAILED_OUTCOMES  = new Set(['decided_not_to_continue', 'ended_roommate_relationship']);

const num = (x) => {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return null;
};

// Option index out of the stored wire shape ({index}|{value}|bare number|string).
function optionIndex(v) {
  if (v == null) return null;
  const n = num(v);
  if (n !== null) return n;
  if (typeof v === 'object') return optionIndex(v.index != null ? v.index : v.value);
  return null;
}

// Per-question agreement in [0,1]: 1 = identical answer, 0 = maximally far.
function agreement(ai, bi, optionCount) {
  const maxDiff = Math.max(1, (optionCount || 4) - 1);
  return 1 - Math.abs(ai - bi) / maxDiff;
}

// Ground-truth label for ONE pair from all its outcome rows (both directions).
//   worked = met in person AND a positive retention signal (yes / rating >= 4)
//   failed = decided_not_to_continue / ended, OR any rating <= 2
//   null   = unknown / too-early → EXCLUDED from training (never forced)
// A failure signal wins over an earlier positive one (a pair that ended failed,
// however well day-30 went).
//
// moved_in_together is treated differently from the other MET_OUTCOMES: it's
// the strongest individual claim ("we actually live together"), and unlike
// met_in_person/lease_signed it has a real corroboration mechanism
// (roommateVouches.js's bothMovedInTogether — the OTHER side gets nudged to
// independently confirm it, see matchOutcomes.js). Before that, ONE person's
// full self-reported journey (move-in claim + their own positive retention
// check-ins) was enough to label a pair "worked" with zero input from the
// other person — this is what let a training pair be entirely one-sided.
// Now a moved_in_together row only counts toward `met` once it's present
// from TWO DISTINCT reporters for this pair (rows carry `reporterId` when
// the caller has real reporter identity — see weightAnalyst.js). A single
// unilateral moved_in_together claim can still label the pair "worked" via
// a plain meet48 'yes' (a lower-stakes claim, unchanged) — it just can't do
// it alone on the strength of an unconfirmed "we moved in" claim.
function labelPair(rows) {
  let met = false, retentionPos = false, failed = false;
  const movedInReporters = new Set();

  for (const r of rows || []) {
    const outcome = r.outcome;
    const stage   = r.stage   != null ? r.stage   : (r.details && r.details.stage);
    const answer  = r.answer  != null ? r.answer  : (r.details && r.details.answer);
    const rating  = num(r.rating != null ? r.rating : (r.details && r.details.rating));
    const reporterId = r.reporterId != null ? r.reporterId : (r.details && r.details.reporterId);

    if (FAILED_OUTCOMES.has(outcome)) failed = true;
    if (rating != null && rating <= 2) failed = true;

    if (outcome === 'moved_in_together') {
      if (reporterId != null) movedInReporters.add(reporterId);
    } else if (MET_OUTCOMES.has(outcome)) {
      met = true; // met_in_person / lease_signed — no corroboration infra, unchanged
    }
    if (stage === 'meet48' && answer === 'yes') met = true;

    if (RETENTION_STAGES.has(stage)) {
      if (answer === 'yes') retentionPos = true;
      if (rating != null && rating >= 4) retentionPos = true;
    }
  }
  if (movedInReporters.size >= 2) met = true; // both sides independently confirmed

  if (failed) return 'failed';
  if (met && retentionPos) return 'worked';
  return null; // too-early / unknown
}

// Pearson correlation — for a binary y (0/1) and continuous x this IS the
// point-biserial coefficient. Returns null when a class is empty or x/y has no
// variance (correlation undefined — honestly "no signal", not 0).
function pointBiserial(samples) {
  const pts = (samples || []).filter(
    (s) => Number.isFinite(s.x) && (s.y === 0 || s.y === 1),
  );
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return null; // no variance → undefined
  return sxy / Math.sqrt(sxx * syy);
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// w_new = (n/(n+k))·w_data + (k/(n+k))·w_expert — shrink toward the prior,
// data earns more say as n grows. k = 0 → pure data; n = 0 → pure prior.
function regularize(wData, wExpert, n, k = K_SHRINK) {
  const alpha = n / (n + k);
  return alpha * wData + (1 - alpha) * wExpert;
}

// Data-target weight for a question from its predictive signal r (−1..1):
// agreement that predicts success (r>0) pushes the weight up, agreement that
// predicts nothing/failure pushes it down. Floored at 0.
function dataTargetWeight(currentWeight, r) {
  if (r == null) return currentWeight; // no signal → data target = prior (no move)
  return Math.max(0, currentWeight * (1 + clamp(r, -1, 1)));
}

// Build (agreement, worked?) samples per question across labeled pairs, then
// derive the point-biserial signal + a regularized proposed weight per question.
//   labeledPairs: [{ label:'worked'|'failed', aId, bId }]
//   answersByUser: { userId: { qid: wireAnswer } }  (flattened later)
//   priorWeights:  QUESTION_POINTS to shrink toward (global expert, or global
//                  weights when proposing a per-school layer)
function perQuestionSignals(labeledPairs, answersByUser, priorWeights, optionCounts, k) {
  const qids = Object.keys(priorWeights).map(Number);
  const samplesByQ = new Map(qids.map((q) => [q, []]));
  let decided = 0;

  for (const pair of labeledPairs || []) {
    const y = pair.label === 'worked' ? 1 : pair.label === 'failed' ? 0 : null;
    if (y === null) continue;
    decided++;
    const A = answersByUser[pair.aId] || {};
    const B = answersByUser[pair.bId] || {};
    for (const q of qids) {
      const ai = optionIndex(A[q]);
      const bi = optionIndex(B[q]);
      if (ai == null || bi == null) continue;
      samplesByQ.get(q).push({ x: agreement(ai, bi, (optionCounts || {})[q]), y });
    }
  }

  const signals = qids.map((q) => {
    const samples = samplesByQ.get(q);
    const worked  = samples.filter((s) => s.y === 1);
    const failed  = samples.filter((s) => s.y === 0);
    const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v.x, 0) / arr.length : null);
    const r = pointBiserial(samples);
    const current   = priorWeights[q];
    const dataW     = dataTargetWeight(current, r);
    const proposed  = Math.round(regularize(dataW, current, decided, k));
    return {
      qid: q,
      current,
      coefficient: round2(r),                 // point-biserial: agreement ↔ worked
      agreementWorked: round2(mean(worked)),
      agreementFailed: round2(mean(failed)),
      pairN: samples.length,
      dataWeight: Math.round(dataW),
      proposedWeight: proposed,
    };
  }).sort((a, b) => (b.coefficient ?? -Infinity) - (a.coefficient ?? -Infinity));

  return { decided, signals };
}

// Flag implausible proposed shifts BEFORE a human sees them (pure stat, not an
// LLM): a big relative move on a thin per-question sample is suspicious.
function detectAnomalies(signals, { relThreshold = 0.5, minPairN = 50 } = {}) {
  const out = [];
  for (const s of signals) {
    if (!s.current) continue;
    const rel = Math.abs(s.proposedWeight - s.current) / s.current;
    if (rel >= relThreshold && s.pairN < minPairN) {
      out.push({
        qid: s.qid,
        reason: `weight moves ${Math.round(rel * 100)}% on only ${s.pairN} pairs with an answer`,
        current: s.current,
        proposed: s.proposedWeight,
        pairN: s.pairN,
      });
    }
  }
  return out;
}

// Fingerprint a proposed weight map — used to dedup review-queue entries and to
// stamp the change log. Stable key order, so identical proposals hash equal.
function weightFingerprint(weights) {
  const keys = Object.keys(weights).map(Number).sort((a, b) => a - b);
  return keys.map((k) => `${k}:${weights[k]}`).join(',');
}

// ── The proposal (Phase 2 global, Phase 3 per-school share the engine) ──────
// scope:  'global'  → shrink toward the expert prior; ready at MIN_N_GLOBAL.
//         { school } → shrink toward the GLOBAL weights; ready at MIN_N_SCHOOL.
// Returns { ready, scope, decided, method, minN, proposedWeights, signals,
//           anomalies, fingerprint }. NEVER applies anything.
function propose({ labeledPairs, answersByUser, priorWeights, optionCounts, scope = 'global', k = K_SHRINK }) {
  const isSchool = scope !== 'global';
  const minN = isSchool ? MIN_N_SCHOOL : MIN_N_GLOBAL;
  const { decided, signals } = perQuestionSignals(labeledPairs, answersByUser, priorWeights, optionCounts, k);

  const proposedWeights = {};
  for (const s of signals) proposedWeights[s.qid] = s.proposedWeight;

  return {
    ready: decided >= minN,
    scope,
    decided,
    minN,
    method: 'point-biserial(agreement, worked) → regularized w_new=(n/(n+k))·w_data+(k/(n+k))·w_prior'
      + (isSchool ? ' shrunk toward GLOBAL weights' : ' shrunk toward the expert prior'),
    k,
    proposedWeights,
    signals,
    anomalies: detectAnomalies(signals),
    fingerprint: weightFingerprint(proposedWeights),
  };
}

module.exports = {
  K_SHRINK, MIN_N_GLOBAL, MIN_N_SCHOOL,
  optionIndex, agreement, labelPair, pointBiserial, regularize,
  dataTargetWeight, perQuestionSignals, detectAnomalies, weightFingerprint, propose,
};
