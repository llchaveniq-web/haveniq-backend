// ═══════════════════════════════════════════════════════════════
//  HavenIQ Compatibility Scoring Engine — Server Side
//
//  A faithful mirror of the app's quizStore.ts:calculateCompatibility,
//  for the v4 22-question quiz. This is the engine that produces every
//  stored row in compatibility_scores (see routes/quiz.js scoreNewMatches).
//
//  Cheap, deterministic, non-AI: a weighted sum over the 22 quiz answers
//  with hard blocks (dealbreakers → 0%) and soft blocks (friction → score
//  reduction). Same inputs always produce the same score.
//
//  IDs are non-contiguous — preserved from the original 60-question set.
//  If the quiz changes in the app's constants/quiz.ts, mirror it here.
// ═══════════════════════════════════════════════════════════════

// Per-question point values — must match the app's quizStore.ts QUESTION_POINTS.
// Keep this in lockstep with the frontend, or backend-computed scores will
// drift from anything the app shows.
//
// ── v8 LIFESTYLE-FIRST REWEIGHT (2026-06-24) ──────────────────────────────
// Realigned to what actually drives roommate conflict: daily-living friction.
// REMOVED from scoring entirely (abstract-personality + equity-risk signals
// that don't predict cohabitation and/or carried fairness risk): attachment
// (1/3/22), emotional-regulation (9), directness (17), childhood/ACEs (29),
// shadow/HEXACO (31/32/34/58), Big Five (15/25/35/45/61), polyvagal (37/40),
// and the categorical sensory item (59 — its options aren't an ordinal scale,
// so distance-scoring it was meaningless). Remaining 14 questions, ~54%
// lifestyle / ~39% behavioral-conflict / ~8% money. First pass; the per-school
// weight-learning step (pairing_outcomes) will retune these from real outcomes.
const QUESTION_POINTS = {
  // ── Lifestyle (daily-living friction) — ~54% ──
  50: 45,  // cleanliness — shared-space standard
  49: 35,  // bedtime
  48: 30,  // hosting / guests
  53: 25,  // study / focus environment
  55: 20,  // food & kitchen sharing
  54: 20,  // alcohol comfort
  52: 20,  // overnight partners
  51: 15,  // smoke / vape / cannabis at home
  // ── Behavioral-conflict scenarios — ~39% ──
  14: 35,  // contempt (Gottman #1 predictor)
  57: 18,  // executive function — v9: was 30 (Q50 already carries tidiness)
  60: 30,  // repair receptivity (after an apology)
  63: 16,  // repair initiation — v9: was 28 (Q60 already carries repair)
  62: 28,  // boundary-setting
  // ── Money — ~8% ──
  56: 30,  // spending alignment
};

// Category → question ids. Re-derived from the surviving v8 ids: every
// category whose ids were all removed is dropped (attachment, emotional,
// childhood, shadow, personality). Each category's max is the sum of its
// surviving QUESTION_POINTS; the breakdown guards against 0/0. Keys are kept
// stable so the existing display mappings (HABIT_LABEL, CATEGORY_DISPLAY,
// generateWhyMatched) keep resolving without a frontend change.
const CATEGORIES = {
  lifestyle:     { ids: [48, 49, 50, 51, 52, 54, 55, 56], label: 'Lifestyle' },      // 215
  communication: { ids: [14, 60, 62, 63],                 label: 'Communication' },  // 121
  control:       { ids: [57],                             label: 'Control Style' },  //  30
  nervous:       { ids: [53],                             label: 'Focus & Environment' }, // 25
};

// ── Dealbreaker → amplified question IDs ─────────────────────────────────
// Each student picks up to 3 "what matters most to you" tags during
// profile setup. At scoring time we union both users' tags and amplify
// (×1.75) the QUESTION_POINTS for every question those tags map to.
//
// Symmetric by design: if EITHER side flagged cleanliness, cleanliness
// becomes weighty for the pair. This trades some asymmetric purity
// (one student doesn't care about X, the other does) for a single
// stored compatibility row per pair — keeps the data model simple at
// 1k users, can revisit at 100k.
//
// Tag → question IDs:
//   sleep        → Q49 (bedtime)
//   cleanliness  → Q50 (shared-space cleanliness)
//   substances   → Q51 (smoke/vape/cannabis at home)
//   alcohol      → Q54 (alcohol comfort)
//   money        → Q56 (spending alignment)
//   guests       → Q48 (guest frequency)
//   communication→ Q14, Q17, Q60 (contempt, directness, repair)
//   noise        → Q59 (sensory disturbance)
//   space        → Q37 (alone-time recharge needs)
// v8: 'noise' (Q59) and 'space' (Q37) tags dropped — their questions were
// removed from scoring. A user who still carries those tags simply finds no
// ids to amplify (harmless no-op).
const DEALBREAKER_QUESTIONS = {
  sleep:         [49],
  cleanliness:   [50],
  substances:    [51],
  alcohol:       [54],
  money:         [56],
  guests:        [48],
  communication: [14, 60, 62, 63],
};
const DEALBREAKER_MULTIPLIER = 1.75;

// ── Answer normalization ─────────────────────────────────────────────────
// quiz_answers.answers is stored in the app's wire shape, one of:
//   { type: 'option', index: N }  ·  { type: 'scale', value: N }  ·  bare N
// Flatten to { questionId: optionIndex }. Tolerates already-flat input.
function flatten(answers) {
  const flat = {};
  if (!answers || typeof answers !== 'object') return flat;
  // Coerce to a finite number, accepting numeric STRINGS too. Without the
  // string path, an answer stored as "2" (some client/JSON paths) was silently
  // dropped — the question then never counted, quietly skewing the score.
  // Index 0 must survive (it's a valid option), so test finiteness, not truthiness.
  const num = (x) => {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
    return null;
  };
  for (const [k, v] of Object.entries(answers)) {
    let n = num(v);
    if (n === null && v && typeof v === 'object') {
      n = num(v.index);
      if (n === null) n = num(v.value);
    }
    if (n !== null) flat[k] = n;
  }
  return flat;
}

function optIdx(flat, qid) {
  const v = flat[qid];
  return typeof v === 'number' ? v : null;
}

// Option counts for the few SCORED questions that aren't the 4-option default.
// Normalizes answer-distance by scale length (see diffScore). KEEP IN LOCKSTEP
// with the quiz options (backend src/data/quizQuestions.js · app
// constants/quiz.ts) — anything not listed is treated as 4 options.
const OPTION_COUNTS = { 14: 2 };  // v8: Q14 contempt is the only surviving non-4-option scored item

// Points earned for an answer pair, scaled by how far apart the two answers are
// RELATIVE to the question's number of options. We map the raw index distance
// onto the canonical 4-option (0..3) reference scale, so a FULL disagreement
// costs the same no matter how many options a question has.
//
// Why: a flat "diff 1 = 60%" curve under-penalized small-scale questions — on a
// 2-option (yes/no) item the MAX gap is 1, so a TOTAL disagreement scored 60%,
// meaning a complete clash on a binary (contempt, stonewalling — high-weight
// shadow/communication Qs) counted as MORE compatible than being 2 apart on a
// 4-option item. Normalizing fixes that: a full binary clash now scores 0%.
// 4-option questions are UNCHANGED (eq === diff → identical to the old curve).
// MUST match app stores/quizStore.ts diffScore.
function diffScore(pts, diff, numOptions) {
  const maxDiff = Math.max(1, (numOptions || 4) - 1);
  const eq = (diff * 3) / maxDiff;            // distance on the 0..3 reference scale
  let frac;                                   // piecewise-linear: 0→1, 1→.6, 2→.2, 3→0
  if (eq <= 0)      frac = 1;
  else if (eq <= 1) frac = 1 - 0.15 * eq;          // v9: one notch = 15% (was 40%)
  else if (eq <= 2) frac = 0.85 - 0.35 * (eq - 1);
  else if (eq <= 3) frac = 0.5 - 0.5 * (eq - 2);
  else              frac = 0;
  return Math.round(pts * frac);
}

// ── Display calibration ──────────────────────────────────────────────────
// Raw weighted-agreement regresses toward ~50% as questions accumulate (law of
// large numbers), so unscaled scores compress into a narrow ~45-65 band —
// "everyone's a 65% match," 94% unreachable, 52% meaningless. Stretch the band
// around the 50 midpoint so the displayed score uses the full range and real
// differences are visible. MONOTONIC: a better-agreeing pair always scores
// higher, so ranking + honesty are preserved; nothing is fabricated. GAIN/MID
// are a first-pass calibration — retune against real paired-outcome data
// (the N≈50 60-day check-ins the weights comment already anticipates).
const CAL_GAIN = 1.15; // v9: was 1.3
const CAL_MID  = 50;
function calibrate(rawPct) {
  const stretched = CAL_MID + (rawPct - CAL_MID) * CAL_GAIN;
  return Math.min(99, Math.max(5, stretched));
}

/**
 * @param rawA, rawB — answer maps (wire shape or flat)
 * @param opts.dealbreakers — array of dealbreaker tags from the UNION of
 *   both users' picks (e.g., ['sleep', 'cleanliness']). The QUESTION_POINTS
 *   for every question in those tags get amplified by DEALBREAKER_MULTIPLIER
 *   before scoring, so a mismatch on a flagged dimension hits the score
 *   harder than a mismatch on a non-flagged one. Empty / undefined disables
 *   the amplification (falls back to vanilla weights).
 * @param opts.weights — OPTIONAL per-question point overrides for what-if
 *   modeling / A-B tuning. Defaults to the live QUESTION_POINTS, so production
 *   behavior is unchanged unless a caller explicitly passes alternative weights.
 */
function calculateCompatibility(rawA, rawB, opts = {}) {
  const A = flatten(rawA);
  const B = flatten(rawB);
  const POINTS = opts.weights || QUESTION_POINTS;

  // Build the amplified-question set from the union of both users' tags.
  // Stored as a Set<number> for O(1) lookup inside the inner loop.
  const amplifiedQids = new Set();
  const tagsRaw = Array.isArray(opts.dealbreakers) ? opts.dealbreakers : [];
  for (const tag of tagsRaw) {
    const ids = DEALBREAKER_QUESTIONS[String(tag).toLowerCase()];
    if (ids) for (const id of ids) amplifiedQids.add(id);
  }

  let rawScore  = 0;
  let maxScore  = 0;
  const catScores = {};      // cat -> { earned, max }

  for (const [cat, { ids }] of Object.entries(CATEGORIES)) {
    catScores[cat] = { earned: 0, max: 0 };
    for (const qid of ids) {
      const basePts = POINTS[qid] || 0;
      // Amplify questions flagged as a dealbreaker by either user (×1.75) —
      // strong enough to reshape ranking, gentle enough not to dominate.
      const pts = amplifiedQids.has(qid)
        ? Math.round(basePts * DEALBREAKER_MULTIPLIER)
        : basePts;
      if (pts === 0) continue;

      const ai = optIdx(A, qid);
      const bi = optIdx(B, qid);
      if (ai === null || bi === null) continue;  // score only questions BOTH answered

      // Count toward the max ONLY when BOTH answered, so partial completion
      // (12-core unlocks matching) is scored on shared answers, not penalized
      // for skipped optional ones. Mirrors the app's quizStore.ts.
      maxScore += pts;
      catScores[cat].max += pts;

      const earned = diffScore(pts, Math.abs(ai - bi), OPTION_COUNTS[qid]);
      rawScore += earned;
      catScores[cat].earned += earned;
    }
  }

  // ── Dealbreaker caps (v8) ────────────────────────────────────────────────
  // Replace the old hard-zero / soft-reduction / shadow tangle with explicit
  // ceilings applied AFTER the weighted sum. A flagged mismatch is strongly
  // discouraged (score capped low) but KEPT in the data — not erased — so the
  // per-school weight-learning step can still observe the pairing's outcome.
  // The smoke cap (35) sits below the default feed floor (MATCH_MIN_SCORE=40),
  // so non-smoker × smoker pairs drop out of the feed without a hard zero.
  let cap = 100;
  let capReason = null;
  const sm0 = optIdx(A, 51), sm1 = optIdx(B, 51);
  if (sm0 !== null && sm1 !== null) {
    const lo = Math.min(sm0, sm1), hi = Math.max(sm0, sm1);
    // non-smoker (Never = 0) × someone who smokes/vapes at home (>= 2)
    if (lo === 0 && hi >= 2) { cap = Math.min(cap, 35); capReason = capReason || 'smoking'; }
  }
  const al0 = optIdx(A, 54), al1 = optIdx(B, 54);  // alcohol comfort, opposite ends
  if (al0 !== null && al1 !== null && Math.abs(al0 - al1) >= 3) {
    cap = Math.min(cap, 55); capReason = capReason || 'alcohol';
  }
  const ov0 = optIdx(A, 52), ov1 = optIdx(B, 52);  // overnight partners, opposite ends
  if (ov0 !== null && ov1 !== null && Math.abs(ov0 - ov1) >= 3) {
    cap = Math.min(cap, 55); capReason = capReason || 'overnight';
  }
  const cl0 = optIdx(A, 50), cl1 = optIdx(B, 50);  // v9: cleanliness, opposite ends
  if (cl0 !== null && cl1 !== null && Math.abs(cl0 - cl1) >= 3) {
    cap = Math.min(cap, 50); capReason = capReason || 'cleanliness';
  }

  const layer1Pct = maxScore > 0 ? (rawScore / maxScore) * 100 : 0;

  // Confidence cap — a sparse or straight-lined answer vector can't earn a top
  // score (without it, thin/uniform profiles hit ~99 against everyone). Pair
  // uses the lower of the two users'. Threshold 10 fits the v8 14-question set
  // so a core completer isn't unfairly throttled.
  const _confIdx = (X) => {
    const v = [];
    for (const { ids } of Object.values(CATEGORIES))
      for (const qid of ids) { const i = optIdx(X, qid); if (i !== null) v.push(i); }
    return v;
  };
  const _cv = (v) => (v.length < 10 ? 0.6 : (new Set(v).size <= 2 ? 0.7 : 1.0));
  const conf = Math.min(_cv(_confIdx(A)), _cv(_confIdx(B)));

  // PART-0 step 4 — behavioral-validation multiplier (±7.5%). Each user's synced
  // validation_score in [0,1] (default 0.5 = neutral / unknown). A pair whose
  // self-report is behaviorally corroborated gets a small lift; contradicted, a
  // small penalty. Both unknown → mult 1.0 → no change (so callers that don't
  // pass it, incl. the test suite, are unaffected).
  // HONESTY GATE: the multiplier may only be ≠1.0 when BOTH users have a REAL
  // behavioral validation_score. If either is missing, it stays neutral (1.0) —
  // a one-sided signal must never move the score (a wrong "validated" badge is
  // trust fraud). Range is naturally clamped to [0.925, 1.075].
  const realVal = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
  const _vA = realVal(opts.validationA), _vB = realVal(opts.validationB);
  const validationMult = (_vA !== null && _vB !== null)
    ? 1 + 0.15 * ((_vA + _vB) / 2 - 0.5)
    : 1.0;

  // Calibrate (stretch around 50) so displayed scores use the full range.
  // No shared answers (maxScore === 0) → 0: can't score strangers.
  let finalPct = maxScore > 0
    ? Math.min(100, Math.max(0, Math.round(calibrate(layer1Pct) * conf * validationMult)))
    : 0;

  // Dealbreaker ceiling is applied LAST — nothing scores above its cap.
  if (maxScore > 0) finalPct = Math.min(finalPct, cap);

  const isSoftBlocked = cap < 100;

  // Per-category breakdown (0-100), calibrated like the headline so a real
  // strength reads 90+ and a real gap reads 40-. Guards 0/0.
  const breakdown = {};
  for (const [cat, s] of Object.entries(catScores)) {
    breakdown[cat] = s.max > 0 ? Math.round(calibrate((s.earned / s.max) * 100)) : 0;
  }

  return {
    finalPct,
    confidence: conf,
    validationMultiplier: Math.round(validationMult * 100) / 100,  // step-4 behavioral lift/penalty
    isHardBlocked: false,   // v8 uses caps, not hard zeroes
    isSoftBlocked,
    capReason,              // 'smoking' | 'alcohol' | 'overnight' | null
    shadowPenalty: 0,       // retained for DB/back-compat; shadow scoring removed in v8
    breakdown,
  };
}

// Generate a "why you matched" blurb based on top categories
function generateWhyMatched(breakdown, score) {
  const sorted = Object.entries(breakdown || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2);

  const catLabels = {
    attachment:    'attachment style',
    emotional:     'emotional patterns',
    control:       'approach to shared space',
    communication: 'communication style',
    childhood:     'background and upbringing',
    shadow:        'honesty and self-awareness',
    nervous:       'energy and rhythm',
    personality:   'personality fit',
    lifestyle:     'daily lifestyle habits',
  };

  const top = sorted.map(([cat]) => catLabels[cat] || cat);
  const a = top[0] || 'compatibility';
  const b = top[1] || a;
  if (score >= 95) {
    // Reserve the system-wide superlative for the genuinely rare top — the
    // calibration crowds 90+, so "strongest in our system" must mean 95+.
    return `Exceptional alignment — your ${a} and ${b} are remarkably similar. About as compatible as our matching gets.`;
  } else if (score >= 90) {
    return `Exceptional alignment — your ${a} and ${b} line up unusually well.`;
  } else if (score >= 80) {
    return `Strong compatibility in ${a} and ${b}. A few differences to discuss but nothing dealbreaking.`;
  } else {
    return `Meaningful overlap in ${a}. Some lifestyle differences worth talking through before committing.`;
  }
}

/**
 * Squad-to-squad compatibility — averages the pairwise score across every
 * cross-group member pair. If any pairwise score is a hard block, the
 * overall group is hard-blocked (one bad pairing ruins the household).
 *
 * Inputs are arrays of answer maps (wire shape or flat — calculateCompatibility
 * normalizes either). Returns null when either group has zero quiz-completed
 * members — caller should hide those groups rather than show a misleading 0%.
 */
function calculateGroupCompatibility(membersA, membersB, opts = {}) {
  if (!Array.isArray(membersA) || !Array.isArray(membersB)) return null;
  if (membersA.length === 0 || membersB.length === 0) return null;

  let sum = 0;
  let count = 0;
  let softBlocked = false;
  for (const a of membersA) {
    for (const b of membersB) {
      const r = calculateCompatibility(a, b, opts);
      if (r.isHardBlocked) {
        return { finalPct: 0, isHardBlocked: true, isSoftBlocked: false, pairs: count };
      }
      if (r.isSoftBlocked) softBlocked = true;
      sum += r.finalPct;
      count += 1;
    }
  }
  if (count === 0) return null;
  return {
    finalPct: Math.round(sum / count),
    isHardBlocked: false,
    isSoftBlocked: softBlocked,
    pairs: count,
  };
}

module.exports = {
  calculateCompatibility,
  generateWhyMatched,
  calculateGroupCompatibility,
  diffScore,        // exported for direct unit tests of the option-count normalization
  OPTION_COUNTS,
  QUESTION_POINTS,  // exported for the engine-analysis script (weight audit)
  DEALBREAKER_QUESTIONS,
  DEALBREAKER_MULTIPLIER,
  // Exported so SNAPSHOT_CATEGORIES in routes/quiz.js can derive its
  // map from the canonical source instead of duplicating ids by hand.
  CATEGORIES,
};
