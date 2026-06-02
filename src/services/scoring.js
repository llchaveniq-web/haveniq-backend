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
const QUESTION_POINTS = {
  1: 40,  3: 40, 22: 25,        // attachment
  9: 35,                        // emotional regulation
  14: 35, 17: 35, 60: 30,       // communication
  29: 20,                       // childhood
  31: 40, 32: 40, 34: 40, 58: 35, // shadow
  37: 14, 40: 12, 59: 14,       // nervous system
  57: 30,                       // control / executive function
  48: 5,  49: 5,  50: 4, 51: 5, 54: 5, 56: 20, // lifestyle
  // Big Five Personality (v5 — added May 2026). Weights tuned to the
  // cohabitation-research hierarchy: Conscientiousness > Agreeableness
  // > Emotional Stability > Extraversion. ~21% of total max. Retune
  // after N=50 paired 60-day check-ins land. See frontend quizStore.ts
  // for the full rationale.
  15: 20,  // Extraversion
  25: 45,  // Conscientiousness
  35: 40,  // Agreeableness
  45: 32,  // Emotional Stability
};

// Category → question ids. The new `personality` bucket holds the
// four Big Five items (HEXACO Honesty-Humility stays in `shadow` since
// it's a more diagnostic dark-trait signal there).
const CATEGORIES = {
  attachment:    { ids: [1, 3, 22],               label: 'Attachment Style' },
  emotional:     { ids: [9],                      label: 'Emotional Style'  },
  communication: { ids: [14, 17, 60],             label: 'Communication'    },
  childhood:     { ids: [29],                     label: 'Childhood'        },
  shadow:        { ids: [31, 32, 34, 58],         label: 'Shadow Traits'    },
  nervous:       { ids: [37, 40, 59],             label: 'Nervous System'   },
  control:       { ids: [57],                     label: 'Control Style'    },
  personality:   { ids: [15, 25, 35, 45],         label: 'Personality'      },
  lifestyle:     { ids: [48, 49, 50, 51, 54, 56], label: 'Lifestyle'        },
};

// Shadow-trait questions: index of the "worst" answer + index of the
// "best" (most honest) answer. A shadow flag fires when one user picks
// the worst end and the other picks the best end. Matches the app's
// quizStore.ts SHADOW_WORST_INDEX. Q14/31/32 are forced-choice (2
// options); Q58 has 4 options.
const SHADOW_WORST_INDEX = { 14: 0, 31: 0, 32: 0, 58: 0 };
const SHADOW_BEST_INDEX  = { 14: 1, 31: 1, 32: 1, 58: 3 };

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
const DEALBREAKER_QUESTIONS = {
  sleep:         [49],
  cleanliness:   [50],
  substances:    [51],
  alcohol:       [54],
  money:         [56],
  guests:        [48],
  communication: [14, 17, 60],
  noise:         [59],
  space:         [37],
};
const DEALBREAKER_MULTIPLIER = 1.75;

// ── Answer normalization ─────────────────────────────────────────────────
// quiz_answers.answers is stored in the app's wire shape, one of:
//   { type: 'option', index: N }  ·  { type: 'scale', value: N }  ·  bare N
// Flatten to { questionId: optionIndex }. Tolerates already-flat input.
function flatten(answers) {
  const flat = {};
  if (!answers || typeof answers !== 'object') return flat;
  for (const [k, v] of Object.entries(answers)) {
    if (typeof v === 'number') { flat[k] = v; continue; }
    if (v && typeof v === 'object') {
      if (typeof v.index === 'number')      flat[k] = v.index;
      else if (typeof v.value === 'number') flat[k] = v.value;
    }
  }
  return flat;
}

function optIdx(flat, qid) {
  const v = flat[qid];
  return typeof v === 'number' ? v : null;
}

// Points earned for an answer pair, by index distance.
// diff 0 → full points, 1 → 60%, 2 → 20%, 3+ → nothing.
function diffScore(pts, diff) {
  if (diff === 0) return pts;
  if (diff === 1) return Math.round(pts * 0.6);
  if (diff === 2) return Math.round(pts * 0.2);
  return 0;
}

/**
 * @param rawA, rawB — answer maps (wire shape or flat)
 * @param opts.dealbreakers — array of dealbreaker tags from the UNION of
 *   both users' picks (e.g., ['sleep', 'cleanliness']). The QUESTION_POINTS
 *   for every question in those tags get amplified by DEALBREAKER_MULTIPLIER
 *   before scoring, so a mismatch on a flagged dimension hits the score
 *   harder than a mismatch on a non-flagged one. Empty / undefined disables
 *   the amplification (falls back to vanilla weights).
 */
function calculateCompatibility(rawA, rawB, opts = {}) {
  const A = flatten(rawA);
  const B = flatten(rawB);

  // Build the amplified-question set from the union of both users' tags.
  // Stored as a Set<number> for O(1) lookup inside the inner loop.
  const amplifiedQids = new Set();
  const tagsRaw = Array.isArray(opts.dealbreakers) ? opts.dealbreakers : [];
  for (const tag of tagsRaw) {
    const ids = DEALBREAKER_QUESTIONS[String(tag).toLowerCase()];
    if (ids) for (const id of ids) amplifiedQids.add(id);
  }

  let rawScore     = 0;
  let maxScore     = 0;
  let hardBlocked  = false;
  let isSoftBlocked = false;
  let softReduction = 0;     // 0-1, from soft blocks
  let shadowFlags   = 0;
  const catScores = {};      // cat -> { earned, max }

  for (const [cat, { ids }] of Object.entries(CATEGORIES)) {
    catScores[cat] = { earned: 0, max: 0 };
    for (const qid of ids) {
      const basePts = QUESTION_POINTS[qid] || 0;
      // Amplify questions flagged as dealbreakers by either user. Math.round
      // keeps the points an integer for consistent ratios downstream; the
      // multiplier is conservative (1.75×) — strong enough that a flagged
      // mismatch reshapes the ranking, gentle enough that it doesn't fully
      // override the deep psych dimensions (attachment, shadow).
      const pts = amplifiedQids.has(qid)
        ? Math.round(basePts * DEALBREAKER_MULTIPLIER)
        : basePts;
      if (pts === 0) continue;

      const ai = optIdx(A, qid);
      const bi = optIdx(B, qid);

      // Every scored question counts toward the max, answered or not —
      // an unanswered question can't earn points (mirrors the app).
      maxScore += pts;
      catScores[cat].max += pts;

      if (ai === null || bi === null) continue;

      const diff   = Math.abs(ai - bi);
      const earned = diffScore(pts, diff);
      rawScore += earned;
      catScores[cat].earned += earned;

      // ── Hard block: Q51 substances — "Never" vs "Regularly" ──────
      if (qid === 51 && ((ai === 0 && bi === 3) || (ai === 3 && bi === 0))) {
        hardBlocked = true;
      }
      // ── Hard block: Q49 bedtime — extreme sleep-schedule gap ─────
      if (qid === 49 && diff >= 3) {
        hardBlocked = true;
      }
      // ── Soft block: Q54 alcohol comfort mismatch ─────────────────
      if (qid === 54 && diff >= 3) {
        isSoftBlocked = true;
        softReduction += 0.15;
      }
      // ── Soft block: Q50 cleanliness standards diverge ────────────
      if (qid === 50 && diff >= 3) {
        isSoftBlocked = true;
        softReduction += 0.20;
      }
      // ── Shadow flag: one honest-worst vs one honest-best ─────────
      if (qid in SHADOW_WORST_INDEX) {
        const worst = SHADOW_WORST_INDEX[qid];
        const best  = SHADOW_BEST_INDEX[qid];
        if ((ai === worst && bi === best) || (bi === worst && ai === best)) {
          shadowFlags += 1;
        }
      }
    }
  }

  // Two or more shadow flags between the pair = a real honesty mismatch.
  const shadowPenalty = shadowFlags >= 2 ? 0.15 : 0;

  // Total reduction is capped so a pair never loses more than 40%.
  const totalReduction = Math.min(0.40, softReduction + shadowPenalty);

  const layer1Pct = maxScore > 0 ? (rawScore / maxScore) * 100 : 0;
  let finalPct = Math.round(layer1Pct * (1 - totalReduction));
  finalPct = Math.min(100, Math.max(0, finalPct));

  // Hard block trumps everything.
  if (hardBlocked) finalPct = 0;

  // Per-category breakdown (0-100) for the match-detail screen.
  const breakdown = {};
  for (const [cat, s] of Object.entries(catScores)) {
    breakdown[cat] = s.max > 0 ? Math.round((s.earned / s.max) * 100) : 0;
  }

  return {
    finalPct,
    isHardBlocked: hardBlocked,
    isSoftBlocked,
    shadowPenalty: Math.round(shadowPenalty * 100),
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
  if (score >= 90) {
    return `Exceptional alignment — your ${a} and ${b} are remarkably similar. This is one of the strongest matches in our system.`;
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
  DEALBREAKER_QUESTIONS,
  DEALBREAKER_MULTIPLIER,
  // Exported so SNAPSHOT_CATEGORIES in routes/quiz.js can derive its
  // map from the canonical source instead of duplicating ids by hand.
  CATEGORIES,
};
