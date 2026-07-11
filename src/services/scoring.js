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

// Deep-matching #2: per-dimension learned shapes (basis dist/mean/min/max/prod).
// Pure helper; cold-start (no certified shape) returns delta 0 ⇒ scoring is
// today's diffScore, bit-for-bit. See services/dimensionBasis.js.
const { displayDelta } = require('./dimensionBasis');
// Deep-matching #6: trajectory projection + convergence. Pure; no-op without
// reliable drift, so cold-start scoring stays bit-for-bit today.
const { projectIndex, convergence, HORIZON_DEFAULT_DAYS } = require('./trajectory');

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
// ── Shared weight version stamp (outcome-learning lockstep) ───────────────
// The frontend mirrors QUESTION_POINTS in constants/quiz.ts / quizStore.ts.
// Every APPROVED weight change (Phase 2/3 of the outcome-learning loop) bumps
// this stamp in BOTH repos in the same commit, so a drift between backend and
// app is detectable (a test here pins the fingerprint of QUESTION_POINTS to
// this version — change the weights without bumping the stamp and it fails).
// 'v11.0' = v10 point priors (unchanged) PLUS the v11 evidence-grounded model,
// behind MATCHING_V11: communication scored by ADEQUACY not similarity, and a
// cross-category reweight (communication HIGHEST). QUESTION_POINTS is untouched
// — the v11 change is the aggregation model, not the raw points — so flag-OFF
// scoring is byte-identical to v10. The learning job proposes '*-learned-*'
// successors for human approval, never auto-committing.
const WEIGHTS_VERSION = 'v11.0';

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
  // ── v10 high-friction axes (optional; per-pair, scored only when BOTH
  //    answered, so additive to existing pairs' scores, never dilutive) ──
  66: 28,  // sleep sensitivity — can you sleep THROUGH noise/light (≠ Q49 bedtime)
  67: 28,  // bill reliability — pays their share on time (≠ Q56 money values)
  65: 20,  // thermostat / temperature preference
  68: 20,  // weekday morning / bathroom timing
};

// Category → question ids. Re-derived from the surviving v8 ids: every
// category whose ids were all removed is dropped (attachment, emotional,
// childhood, shadow, personality). Each category's max is the sum of its
// surviving QUESTION_POINTS; the breakdown guards against 0/0. Keys are kept
// stable so the existing display mappings (HABIT_LABEL, CATEGORY_DISPLAY,
// generateWhyMatched) keep resolving without a frontend change.
const CATEGORIES = {
  lifestyle:     { ids: [48, 49, 50, 51, 52, 54, 55, 56, 65, 67, 68], label: 'Lifestyle' },      // 283
  communication: { ids: [14, 60, 62, 63],                             label: 'Communication' },  // 121
  control:       { ids: [57],                                         label: 'Control Style' },  //  30
  nervous:       { ids: [53, 66],                                     label: 'Focus & Environment' }, // 53
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
// The fraction [0,1] of a question's points earned at a given answer distance —
// today's similarity curve, factored out so the deep-matching #2 basis layer can
// share it as the cold-start (dist-only) shape.
function diffFrac(diff, numOptions) {
  const maxDiff = Math.max(1, (numOptions || 4) - 1);
  const eq = (diff * 3) / maxDiff;            // distance on the 0..3 reference scale
                                              // piecewise-linear: 0→1, 1→.6, 2→.2, 3→0
  if (eq <= 0)      return 1;
  if (eq <= 1)      return 1 - 0.15 * eq;          // v9: one notch = 15% (was 40%)
  if (eq <= 2)      return 0.85 - 0.35 * (eq - 1);
  if (eq <= 3)      return 0.5 - 0.5 * (eq - 2);
  return 0;
}
function diffScore(pts, diff, numOptions) {
  return Math.round(pts * diffFrac(diff, numOptions));
}

// Human label per scored question, used only for the complementarity callout in
// whyMatched ("your chore styles balance each other"). Never shown unless a
// dimension's shape is gate-certified complementary on real outcomes.
const DIMENSION_LABELS = {
  50: 'cleanliness', 49: 'sleep', 48: 'hosting', 52: 'overnight', 54: 'alcohol',
  51: 'substance', 53: 'focus', 56: 'money', 14: 'communication', 60: 'repair',
  63: 'repair', 62: 'boundary', 57: 'chore',
  65: 'temperature', 66: 'sleep sensitivity', 67: 'bill reliability', 68: 'morning routine',
};
// A pair must be at least this far apart on a complementary dimension for the
// "balance" phrasing to apply — i.e. their difference is genuinely WHY they fit.
const COMPLEMENT_MIN_GAP = 0.5;

// Deep-matching #6 thresholds for surfacing a trajectory ("converging") note:
// the certified shape must weight convergence at least this much AND this pair
// must actually be closing — OR projection must have materially shrunk the gap.
const CONV_COEF_MIN = 0.3;       // shape meaningfully rewards convergence
const CONV_MIN = 0.05;           // this pair is genuinely closing the gap
const PROJ_MATERIAL_GAP = 0.5;   // projection shrank the gap by ≥ half an option (index units)

// Deep-matching #5 (LLM text-insight) tuning. Each certified construct nudges the
// percentage by displayDelta×SCALE, the total bounded by MAX. A pair note fires
// only when the construct is clearly positive AND the two read SIMILAR.
const LLM_DELTA_SCALE = 16;     // displayDelta ∈[-0.5,0.5] → ±8pp per construct
const LLM_DELTA_MAX = 15;       // total LLM adjustment is bounded to ±15pp
const TEXT_INSIGHT_NOTE_MIN = 0.05;
const TEXT_INSIGHT_SIM_MAX = 0.34;
// Plain-language PAIR notes per construct (deep-matching #5). Never raw scores.
const TEXT_INSIGHT_PAIR_NOTES = {
  directness: 'you both write like direct, upfront communicators',
  warmth: 'you both come across as warm and easy to live with',
  planfulness: 'you both read as organized planners',
  conflict_approach: 'you both address friction head-on rather than letting it simmer',
  tidiness_orientation: 'you both signal you care about a tidy shared space',
  social_energy: 'you both come across as social and host-friendly',
  adaptability: 'you both read as flexible, adaptable roommates',
};

// Plain-language convergence notes per question (deep-matching #6). Fallback is
// derived from DIMENSION_LABELS. Never exposes raw slopes.
const CONVERGENCE_NOTES = {
  49: 'your sleep schedules are converging',
  53: 'your focus and study routines are converging',
  50: 'your cleanliness habits are converging',
  48: 'your hosting rhythms are converging',
  54: 'your alcohol comfort levels are converging',
  56: 'your money habits are converging',
  57: 'your chore routines are converging',
  62: 'your boundary styles are converging',
};

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

// ── Matching v11.0 — evidence-grounded two-class model (feature-flagged) ─────
// Behind MATCHING_V11. Flag OFF ⇒ this whole block is inert and scoring is
// byte-identical to v10. Two evidence-grounded changes, both v11-only:
//
//  (1) TWO-CLASS SCORING. Living-habit categories (lifestyle, control, nervous)
//      keep SIMILARITY scoring — similarity-attraction holds SELECTIVELY, for
//      concrete habits + reliability. Communication/conflict-resolution is an
//      ADEQUACY axis, not a similarity one: two avoidant communicators are
//      SIMILAR yet BAD together. So a communication question scores the pair's
//      COMPETENCE — one strong communicator carries the dyad, two strong is
//      best, two weak is worst. (Complementarity-over-similarity was REFUTED.)
//
//  (2) CATEGORY REWEIGHT. Communication is a distinct predictor of dissolution
//      → weight it HIGHEST. Applied as cross-category weights at aggregation,
//      so QUESTION_POINTS is untouched: flag-OFF stays byte-identical and the
//      within-category question weights are preserved.
//
// All weights are PRIORS, to be corrected by real check-in outcomes later — not
// settled constants (no claim that this beats random survived scrutiny).
function matchingV11Enabled(opts) {
  if (opts && opts.v11 !== undefined) return !!opts.v11;   // explicit override: tests + shadow-validation
  return process.env.MATCHING_V11 === 'true';
}

// Cross-category evidence weights (v11). BEFORE — v10 effective point-share:
// communication ~24%, lifestyle ~61%, control ~4%, nervous ~11%. AFTER:
const CATEGORY_WEIGHTS_V11 = {
  communication: 0.34, // HIGHEST — distinct dissolution predictor
  lifestyle:     0.30, // HIGH    — similarity predicts for living habits
  control:       0.20, // HIGH    — reliability / executive function
  nervous:       0.16, // MODERATE
};

// Adequacy combiner: the stronger communicator carries the dyad. Symmetric in
// (a,b); w_max on the stronger, w_min on the weaker; sum 1 ⇒ g ∈ [0,1].
const ADEQ_W_MAX = 0.65;
const ADEQ_W_MIN = 0.35;

// Per-option COMPETENCE [0..1] for each communication question, derived from the
// option TEXT (higher = raises issues directly / repairs conflict; lower =
// avoids / stonewalls / lets resentment build). Non-monotonic where the text is
// (Q62 boundary-setting peaks at "decline kindly", not at the blunt extreme).
// A communication question with no entry here falls back to SIMILARITY even
// under v11 — every one below has a sensible ordering, so none do.
const COMMUNICATION_COMPETENCE = {
  14: [0.0, 1.0],              // contempt(0, worst) → civil-and-direct(1, best); 2-opt
  60: [1.0, 0.7, 0.4, 0.0],    // repair receptivity: accept-fully(0) → resentment-lingers(3)
  62: [0.0, 0.4, 1.0, 0.75],   // boundary: passive-yes(0) → decline-kindly(2, best) → blunt-no(3)
  63: [1.0, 0.75, 0.4, 0.0],   // repair initiation: always-initiates(0) → avoids(3)
};
function communicationCompetence(qid, idx) {
  const row = COMMUNICATION_COMPETENCE[qid];
  return (row && typeof row[idx] === 'number') ? row[idx] : null;
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
  const V11 = matchingV11Enabled(opts);  // OFF ⇒ byte-identical to v10

  // Deep-matching #2: per-question certified shapes. Keyed by question id;
  // absent / uncertified ⇒ the question keeps today's diffScore curve. With no
  // models passed (the default, incl. the test suite) scoring is unchanged,
  // bit-for-bit. complementaryHits collects dims whose DIFFERENCE is why a pair
  // fits (a gate-certified complementary shape + a genuinely far-apart pair).
  const dimensionModels = (opts.dimensionModels && typeof opts.dimensionModels === 'object')
    ? opts.dimensionModels : {};
  const complementaryHits = [];

  // Deep-matching #6: trajectory. driftA/driftB are per-question drift snapshots
  // { velocity, trend, sampleSize } for each user; horizonDays projects forward.
  // All absent (the default) ⇒ effective velocity 0 ⇒ projection == current and
  // convergence == 0 ⇒ scoring is exactly today, bit-for-bit.
  const driftA = (opts.driftA && typeof opts.driftA === 'object') ? opts.driftA : {};
  const driftB = (opts.driftB && typeof opts.driftB === 'object') ? opts.driftB : {};
  const horizonDays = Number.isFinite(opts.horizonDays) ? opts.horizonDays : HORIZON_DEFAULT_DAYS;
  const convergingHits = [];

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

      // Cold-start fraction = today's curve. A certified shape nudges it via the
      // basis (bounded ±DISPLAY_DELTA_MAX); uncertified ⇒ delta 0 ⇒ unchanged.
      const numOpts = OPTION_COUNTS[qid] || 4;
      const den = Math.max(1, numOpts - 1);
      const shape = dimensionModels[qid];

      // Deep-matching #6 trajectory for this question. convergence is 0 without
      // reliable drift on BOTH sides; projection only applies when the dimension
      // earned it (shape.project) — otherwise the snapshot index is used.
      // v11 ADEQUACY class — communication only: score the pair's COMPETENCE,
      // not their similarity (two avoidant communicators are similar yet bad).
      // Symmetric; the stronger communicator carries the dyad. Flag OFF or a
      // question with no competence ordering ⇒ both null ⇒ similarity path below.
      const compA = (V11 && cat === 'communication') ? communicationCompetence(qid, ai) : null;
      const compB = (V11 && cat === 'communication') ? communicationCompetence(qid, bi) : null;

      let g;
      if (compA !== null && compB !== null) {
        g = ADEQ_W_MAX * Math.max(compA, compB) + ADEQ_W_MIN * Math.min(compA, compB);
        // No complementary/converging notes for an adequacy dim — those are
        // similarity concepts, and complementarity was refuted for communication.
      } else {
        // SIMILARITY class (lifestyle/control/nervous, and all of v10) — today's
        // curve, byte-identical when the flag is off.
        const dA = driftA[qid], dB = driftB[qid];
        const conv = convergence(ai, bi, dA, dB, den);
        const project = !!(shape && shape.certified && shape.project);
        const aIdx = project ? projectIndex(ai, dA, horizonDays, den) : ai;
        const bIdx = project ? projectIndex(bi, dB, horizonDays, den) : bi;
        const aN = aIdx / den, bN = bIdx / den;

        g = diffFrac(Math.abs(aIdx - bIdx), numOpts);
        if (shape && shape.certified) {
          g = Math.min(1, Math.max(0, g + displayDelta(shape, aN, bN, conv)));
          if (shape.type === 'complementarity' && Math.abs(aN - bN) >= COMPLEMENT_MIN_GAP) {
            complementaryHits.push(qid);
          }
          // Trajectory "converging" note: the shape rewards convergence AND this
          // pair is closing, OR projection materially shrank the gap. Earned only.
          const convCoef = shape.basis && shape.basis.coef ? Number(shape.basis.coef.conv) : NaN;
          const rewardsConv = Number.isFinite(convCoef) && convCoef > CONV_COEF_MIN && conv >= CONV_MIN;
          const projClosed = project && (Math.abs(ai - bi) - Math.abs(aIdx - bIdx)) >= PROJ_MATERIAL_GAP;
          if (rewardsConv || projClosed) convergingHits.push(qid);
        }
      }
      const earned = Math.round(pts * g);
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

  // v10: pooled point-share. v11: cross-category WEIGHTED AVERAGE of each
  // category's own fraction (communication weighted HIGHEST), over categories
  // where BOTH users answered ≥1 question. catScores[cat].max only accrues on
  // both-answered questions, so a category with no shared answers is excluded
  // from numerator AND denominator — the same invariant as v10's maxScore.
  let layer1Pct;
  if (V11) {
    // opts.categoryWeightsV11 overrides the default set (shadow-validation weight
    // sweeps + A/B tuning). Production passes nothing → the live weights.
    const CW = (opts.categoryWeightsV11 && typeof opts.categoryWeightsV11 === 'object')
      ? opts.categoryWeightsV11 : CATEGORY_WEIGHTS_V11;
    let wsum = 0, wtot = 0;
    for (const [cat, w] of Object.entries(CW)) {
      const cs = catScores[cat];
      if (cs && cs.max > 0) { wsum += w * (cs.earned / cs.max); wtot += w; }
    }
    layer1Pct = wtot > 0 ? (wsum / wtot) * 100 : 0;
  } else {
    layer1Pct = maxScore > 0 ? (rawScore / maxScore) * 100 : 0;
  }

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

  // Deep-matching #5: certified LLM text-insight constructs. Each certified
  // construct adds a bounded ± nudge (the gate-fit shape's lift over the base
  // rate for this pair), the total clamped to ±LLM_DELTA_MAX. No certified
  // constructs / no features (the default) ⇒ llmDelta 0 ⇒ scoring is today,
  // bit-for-bit. textInsightHits drive the plain-language whyMatched note.
  const llmModels = (opts.llmModels && typeof opts.llmModels === 'object') ? opts.llmModels : {};
  const llmA = (opts.llmFeaturesA && typeof opts.llmFeaturesA === 'object') ? opts.llmFeaturesA : {};
  const llmB = (opts.llmFeaturesB && typeof opts.llmFeaturesB === 'object') ? opts.llmFeaturesB : {};
  let llmDelta = 0;
  const textInsightHits = [];
  for (const [construct, shape] of Object.entries(llmModels)) {
    if (!shape || !shape.certified) continue;
    const cA = Number(llmA[construct]), cB = Number(llmB[construct]);
    if (!Number.isFinite(cA) || !Number.isFinite(cB)) continue;
    const d = displayDelta(shape, cA, cB, 0);   // [-0.5, 0.5]
    llmDelta += d * LLM_DELTA_SCALE;
    if (d >= TEXT_INSIGHT_NOTE_MIN && Math.abs(cA - cB) <= TEXT_INSIGHT_SIM_MAX) textInsightHits.push(construct);
  }
  llmDelta = Math.max(-LLM_DELTA_MAX, Math.min(LLM_DELTA_MAX, llmDelta));

  // preValidationPct = the compatibility % BEFORE the behavioral multiplier
  // (calibrated + confidence-capped + LLM-adjusted + clamped). The app renders
  // "84% → 90%" from preValidationPct → finalPct. No shared answers ⇒ 0.
  const preValidationPct = maxScore > 0
    ? Math.round(Math.min(100, Math.max(0, calibrate(layer1Pct) * conf + llmDelta)))
    : 0;

  // finalPct = round(clamp(preValidationPct * multiplier)), THEN the dealbreaker
  // ceiling (nothing scores above its cap).
  let finalPct = maxScore > 0
    ? Math.round(Math.min(100, Math.max(0, preValidationPct * validationMult)))
    : 0;
  if (maxScore > 0) finalPct = Math.min(finalPct, cap);

  const isSoftBlocked = cap < 100;

  // Per-category breakdown (0-100), calibrated like the headline so a real
  // strength reads 90+ and a real gap reads 40-. Guards 0/0.
  const breakdown = {};
  for (const [cat, s] of Object.entries(catScores)) {
    breakdown[cat] = s.max > 0 ? Math.round(calibrate((s.earned / s.max) * 100)) : 0;
  }

  // Deep-matching #2: dimensions whose DIFFERENCE is why this pair fits (certified
  // complementary shape + far-apart answers). Empty unless a shape is certified —
  // so the "balance" copy is a finding, never a default. Deduped by label.
  const complementaryDims = [];
  const seenLabels = new Set();
  for (const qid of complementaryHits) {
    const label = DIMENSION_LABELS[qid] || `dimension ${qid}`;
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    complementaryDims.push({ qid: Number(qid), label });
  }

  // Deep-matching #6: dimensions where the two trajectories are materially
  // closing (a certified shape rewards convergence, or projection shrank the
  // gap). Empty unless earned — a finding, never a default. Deduped by label.
  const convergingDims = [];
  const seenConv = new Set();
  for (const qid of convergingHits) {
    const label = DIMENSION_LABELS[qid] || `dimension ${qid}`;
    if (seenConv.has(label)) continue;
    seenConv.add(label);
    convergingDims.push({ qid: Number(qid), label, note: CONVERGENCE_NOTES[qid] || `your ${label} styles are converging` });
  }

  // Deep-matching #5: certified text-insight constructs that read SIMILAR and
  // positive for this pair. Empty unless a construct is certified on outcomes —
  // a finding from their own writing, never a default.
  const textInsightDims = [];
  for (const construct of textInsightHits) {
    const note = TEXT_INSIGHT_PAIR_NOTES[construct];
    if (note) textInsightDims.push({ construct, note });
  }

  return {
    finalPct,
    complementaryDims,      // [{qid,label}] — drives the "your X styles balance" phrasing
    convergingDims,         // [{qid,label,note}] — deep-matching #6 trajectory note
    textInsightDims,        // [{construct,note}] — deep-matching #5 LLM-read note
    preValidationPct,       // headline % BEFORE the behavioral multiplier ("84% → 90%")
    confidence: conf,
    validationMultiplier: Math.round(validationMult * 100) / 100,  // step-4 behavioral lift/penalty
    isHardBlocked: false,   // v8 uses caps, not hard zeroes
    isSoftBlocked,
    capReason,              // 'smoking' | 'alcohol' | 'overnight' | null
    shadowPenalty: 0,       // retained for DB/back-compat; shadow scoring removed in v8
    breakdown,
  };
}

// Generate a "why you matched" blurb based on top categories.
// complementaryDims (optional) = [{qid,label}] from calculateCompatibility for
// dimensions a certified complementary shape says fit BECAUSE they differ. When
// present we LEAD with that ("your chore styles balance each other") — the app's
// compat-report / Fit Report / matches card / AI advisor all read this string.
// Empty/absent ⇒ today's copy verbatim (complementarity is never asserted by
// default; it ships only once the gate certifies it on real outcomes).
// Plain-language label for a dealbreaker cap, so the "why" can name the gap
// instead of spinning positive against a low score.
const FRICTION_CAP_LABEL = {
  cleanliness: 'cleanliness', smoking: 'smoking at home',
  alcohol: 'alcohol comfort', overnight: 'overnight guests',
};

function generateWhyMatched(breakdown, score, complementaryDims = [], convergingDims = [], textInsightDims = [], opts = {}) {
  const { capReason = null, frictionTopic = null, confidence = 1 } = opts;
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

  // HONESTY: a dealbreaker-capped pair has a genuine gap. Never lead with a
  // positive (which would contradict the low score) — name the gap plainly and
  // make it actionable. This is the one place the "why" MUST match the score.
  if (capReason) {
    const topic = FRICTION_CAP_LABEL[capReason] || frictionTopic || 'a core living habit';
    return `The real gap here is ${topic} — a common roommate dealbreaker. You do line up on `
      + `${a}, but that's something you'd need to work out before signing a lease together.`;
  }

  // HONESTY: a low score from THIN data (few answers, or a straight-lined answer
  // vector) is UNCERTAINTY, not a clash. Never blame "differences" we can't
  // actually see yet — say we don't know enough, and point at the fix. Strong
  // pairs that earned 80+ despite reduced confidence keep their positive read.
  if (confidence < 1 && score < 80) {
    return `We don't have enough answers yet to call this pairing with confidence — `
      + `it gets sharper as you both finish more of the quiz.`;
  }

  let base;
  if (score >= 95) {
    // Reserve the system-wide superlative for the genuinely rare top — the
    // calibration crowds 90+, so "strongest in our system" must mean 95+.
    base = `Exceptional alignment — your ${a} and ${b} are remarkably similar. About as compatible as our matching gets.`;
  } else if (score >= 90) {
    base = `Exceptional alignment — your ${a} and ${b} line up unusually well.`;
  } else if (score >= 80) {
    // Even a strong pair has a top thing to compare notes on — name it when we
    // know it, so the "why" is specific, not a generic reassurance.
    base = `Strong compatibility in ${a} and ${b}.`
      + (frictionTopic ? ` The main thing to compare notes on: ${frictionTopic}.`
                       : ` A few differences to discuss but nothing dealbreaking.`);
  } else {
    // Name the single biggest gap instead of a vague "some differences".
    base = frictionTopic
      ? `Meaningful overlap in ${a}, but ${frictionTopic} is where you differ most — worth sorting out before you commit.`
      : `Meaningful overlap in ${a}. Some lifestyle differences worth talking through before committing.`;
  }

  // Deep-matching #6: a plain-language trajectory note when habits are closing
  // (earned + material). Comes after any complementarity lead, before the base.
  const conv = Array.isArray(convergingDims) ? convergingDims : [];
  let trajectory = '';
  if (conv.length === 1) {
    const n = conv[0].note;
    trajectory = `${n.charAt(0).toUpperCase()}${n.slice(1)}. `;
  } else if (conv.length > 1) {
    const labels = conv.map(d => d.label);
    const list = labels.length === 2
      ? `${labels[0]} and ${labels[1]}`
      : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
    trajectory = `You're trending toward each other on ${list}. `;
  }

  // Deep-matching #5: a plain-language note from what a certified LLM construct
  // read in BOTH users' own writing (never raw scores). One note, after the
  // trajectory note, before the base.
  const ti = Array.isArray(textInsightDims) ? textInsightDims : [];
  let insight = '';
  if (ti.length) {
    const n = ti[0].note;
    insight = `${n.charAt(0).toUpperCase()}${n.slice(1)}. `;
  }

  // Lead with complementarity when a certified shape says difference is the fit.
  const comp = Array.isArray(complementaryDims) ? complementaryDims : [];
  if (comp.length) {
    const labels = comp.map(d => d.label);
    const list = labels.length === 1
      ? labels[0]
      : labels.length === 2
        ? `${labels[0]} and ${labels[1]}`
        : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
    return `Your ${list} styles balance each other — opposites that tend to work. ${trajectory}${insight}${base}`;
  }
  return (trajectory || insight) ? `${trajectory}${insight}${base}` : base;
}

// Plain-language friction topic per question (deep-matching #4 suites). The
// single largest weighted answer-gap between two users → the dimension most
// likely to strain that pairing. Reuses the scored set + option counts.
const FRICTION_TOPICS = {
  49: 'sleep schedules', 50: 'cleanliness', 51: 'substances at home',
  48: 'guests & hosting', 52: 'overnight guests', 54: 'alcohol',
  53: 'study environment', 55: 'food & kitchen', 56: 'money & spending',
  14: 'communication', 57: 'chores', 60: 'conflict repair',
  62: 'boundaries', 63: 'conflict repair',
  65: 'thermostat & temperature', 66: 'sleep sensitivity', 67: 'bills & paying on time',
  68: 'morning routines',
};

/**
 * The single dimension most likely to cause friction between two answer sets:
 * the scored question with the largest option-normalized gap, weighted by its
 * points. Returns a plain-language topic ('sleep schedules', 'cleanliness') or
 * null when the pair shares no scored answers (nothing to compare → no claim).
 */
function topFrictionTopic(rawA, rawB) {
  const A = flatten(rawA), B = flatten(rawB);
  let bestQ = null, bestGap = 0;
  for (const qid of Object.keys(QUESTION_POINTS)) {
    const ai = A[qid], bi = B[qid];
    if (typeof ai !== 'number' || typeof bi !== 'number') continue;
    const den = Math.max(1, (OPTION_COUNTS[qid] || 4) - 1);
    const gap = (Math.abs(ai - bi) / den) * (QUESTION_POINTS[qid] || 0);
    if (gap > bestGap) { bestGap = gap; bestQ = qid; }
  }
  if (bestQ === null || bestGap <= 0) return null;
  return FRICTION_TOPICS[bestQ] || null;
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
  topFrictionTopic, // deep-matching #4 — friction topic for a pair (suites)
  diffScore,        // exported for direct unit tests of the option-count normalization
  OPTION_COUNTS,
  QUESTION_POINTS,  // exported for the engine-analysis script (weight audit)
  WEIGHTS_VERSION,  // shared lockstep stamp — see the note by QUESTION_POINTS
  CATEGORY_WEIGHTS_V11,     // v11 cross-category evidence weights (shadow-validation + tests)
  COMMUNICATION_COMPETENCE, // v11 per-option competence map (tests)
  DEALBREAKER_QUESTIONS,
  DEALBREAKER_MULTIPLIER,
  // Exported so SNAPSHOT_CATEGORIES in routes/quiz.js can derive its
  // map from the canonical source instead of duplicating ids by hand.
  CATEGORIES,
};
