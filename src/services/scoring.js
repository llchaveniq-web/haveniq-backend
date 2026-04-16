// ═══════════════════════════════════════════════════════════════
//  HavenIQ Compatibility Scoring Engine — Server Side
//  Mirrors the algorithm in the mobile app's quizStore.ts
// ═══════════════════════════════════════════════════════════════

// Per-question point values (matches app constants)
const QUESTION_POINTS = {
  1:40, 2:25, 3:40, 4:20, 5:25, 6:30, 7:20, 8:30, 9:35, 10:35,
  11:30, 12:35, 13:30, 14:5, 15:25, 16:35, 17:35, 18:5, 19:25, 20:25,
  21:20, 22:10, 23:10, 24:20, 25:15, 26:20, 27:10, 28:25, 29:10, 30:10,
  31:40, 32:40, 33:40, 34:40, 35:40,
  36:7, 37:5, 38:7, 39:7, 40:7, 41:7, 42:7, 43:5, 44:7, 45:7, 46:1, 47:0,
  48:5, 49:5, 50:4, 51:5, 52:3, 53:2, 54:5, 55:4,
};

const SHADOW_IDS = [31, 32, 33, 35];
const FAWN_IDS   = [42, 43, 44];

// Category question ranges
const CATEGORIES = {
  attachment:    { ids: [1,2,3,4,5],     label: 'Attachment Style' },
  emotional:     { ids: [6,7,8,9,10],    label: 'Emotional Style' },
  control:       { ids: [11,12,13,14,15],label: 'Control Style' },
  communication: { ids: [16,17,18,19,20],label: 'Communication' },
  identity:      { ids: [21,22,23,24,25],label: 'Identity' },
  childhood:     { ids: [26,27,28,29,30],label: 'Childhood' },
  shadow:        { ids: [31,32,33,34,35],label: 'Shadow Traits' },
  nervous:       { ids: [36,37,38,39,40],label: 'Nervous System' },
  selfawareness: { ids: [41,42,43,44,45,46,47], label: 'Self-Awareness' },
  lifestyle:     { ids: [48,49,50,51,52,53,54,55], label: 'Lifestyle' },
};

// Score proximity between two answers (0 = worst, 1 = best)
function diffScore(a, b, maxOptions) {
  const diff = Math.abs(a - b);
  if (diff === 0) return 1.0;
  if (diff === 1) return 0.6;
  if (diff === 2) return 0.2;
  return 0.0;
}

function calculateCompatibility(answersA, answersB) {
  // ── Layer 2: Hard blocks ────────────────────────────────────────────
  // Q51 (substances): if one never and other regularly → block
  const q51a = answersA[51] ?? -1;
  const q51b = answersB[51] ?? -1;
  if ((q51a === 0 && q51b === 3) || (q51a === 3 && q51b === 0)) {
    return { finalPct: 0, isHardBlocked: true, isSoftBlocked: false, shadowPenalty: 0, breakdown: {} };
  }

  // Q49 (bedtime): extreme diff → hard block
  const q49a = answersA[49] ?? 2;
  const q49b = answersB[49] ?? 2;
  if (Math.abs(q49a - q49b) >= 3) {
    return { finalPct: 0, isHardBlocked: true, isSoftBlocked: false, shadowPenalty: 0, breakdown: {} };
  }

  // ── Layer 2: Soft blocks / reductions ─────────────────────────────
  let reductions = 0;
  let isSoftBlocked = false;

  const q54a = answersA[54] ?? 2;
  const q54b = answersB[54] ?? 2;
  if (Math.abs(q54a - q54b) >= 3) { reductions += 0.15; isSoftBlocked = true; }

  const q50a = answersA[50] ?? 2;
  const q50b = answersB[50] ?? 2;
  if (Math.abs(q50a - q50b) >= 3) { reductions += 0.20; isSoftBlocked = true; }

  // ── Layer 1: Psychological scoring (Q1–Q55) ────────────────────────
  const totalPossible = Object.values(QUESTION_POINTS).reduce((s, v) => s + v, 0);
  let earnedPoints = 0;

  const breakdown = {};
  for (const [cat, { ids, label }] of Object.entries(CATEGORIES)) {
    let catEarned   = 0;
    let catPossible = 0;
    for (const qid of ids) {
      const pts = QUESTION_POINTS[qid] || 0;
      const a   = answersA[qid] ?? 2;
      const b   = answersB[qid] ?? 2;
      const score = diffScore(a, b, 4) * pts;
      earnedPoints += score;
      catEarned    += score;
      catPossible  += pts;
    }
    breakdown[cat] = catPossible > 0 ? Math.round((catEarned / catPossible) * 100) : 50;
  }

  const layer1Pct = totalPossible > 0 ? earnedPoints / totalPossible : 0;

  // ── Shadow flag penalty ────────────────────────────────────────────
  const shadowFlagsA = SHADOW_IDS.filter(id => (answersA[id] ?? 0) >= 3).length;
  const shadowFlagsB = SHADOW_IDS.filter(id => (answersB[id] ?? 0) >= 3).length;
  const hasShadowMismatch = (shadowFlagsA >= 2) !== (shadowFlagsB >= 2);
  const shadowPenalty = hasShadowMismatch ? 0.15 : 0;

  // ── Fawn flag penalty ─────────────────────────────────────────────
  const fawnFlagsA = FAWN_IDS.filter(id => (answersA[id] ?? 0) >= 3).length;
  const fawnFlagsB = FAWN_IDS.filter(id => (answersB[id] ?? 0) >= 3).length;
  const hasFawnMismatch = (fawnFlagsA >= 2) !== (fawnFlagsB >= 2);
  const fawnPenalty = hasFawnMismatch ? 0.10 : 0;

  // ── Final score ───────────────────────────────────────────────────
  const totalReduction = Math.min(0.40, reductions + shadowPenalty + fawnPenalty);
  const finalPct = Math.max(0, Math.round(layer1Pct * (1 - totalReduction) * 100));

  return {
    finalPct,
    isHardBlocked: false,
    isSoftBlocked,
    shadowPenalty: Math.round(shadowPenalty * 100),
    breakdown,
  };
}

// Generate a "why you matched" blurb based on top categories
function generateWhyMatched(breakdown, score) {
  const sorted = Object.entries(breakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2);

  const catLabels = {
    attachment:    'attachment style',
    emotional:     'emotional patterns',
    control:       'approach to shared space',
    communication: 'communication style',
    identity:      'values and identity',
    childhood:     'background and upbringing',
    shadow:        'self-awareness',
    nervous:       'energy and rhythm',
    selfawareness: 'emotional intelligence',
    lifestyle:     'daily lifestyle habits',
  };

  const top = sorted.map(([cat]) => catLabels[cat] || cat);
  if (score >= 90) {
    return `Exceptional alignment — your ${top[0]} and ${top[1]} are remarkably similar. This is one of the strongest matches in our system.`;
  } else if (score >= 80) {
    return `Strong compatibility in ${top[0]} and ${top[1]}. A few differences to discuss but nothing dealbreaking.`;
  } else {
    return `Meaningful overlap in ${top[0]}. Some lifestyle differences worth talking through before committing.`;
  }
}

module.exports = { calculateCompatibility, generateWhyMatched };
