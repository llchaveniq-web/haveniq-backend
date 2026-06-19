// ─── MBTI / DISC personality-pairing readout ─────────────────────────────
//
// A SECONDARY, display-only "personality lens" shown on the match-detail
// screen. It does NOT drive match ranking — the clinical-quiz weighted
// engine (services/scoring.js) remains the sole compatibility score.
//
// MBTI "compatibility pairing" is pop-psychology, not validated science,
// and is kept deliberately out of the ranking for exactly that reason.
// This readout exists because it's intuitive and fun for students, and
// because the advisor ("Dave's way") asked for a personality pairing
// surfaced on matches with a 60 % MBTI / 40 % DISC weighting.

const MBTI_RE = /^[EI][NS][TF][JP]$/;
const DISC_RE = /^[DISC]{1,2}$/;

const isMbti = (v) => typeof v === 'string' && MBTI_RE.test(v.trim().toUpperCase());
const isDisc = (v) => typeof v === 'string' && DISC_RE.test(v.trim().toUpperCase());

// Per-dichotomy "ideal relationship" heuristic, drawn from the common
// MBTI-pairing literature. None of these is "bad" — a non-ideal pairing
// just scores lower (it still earns half credit).
//   E/I → differ is ideal  (extravert + introvert balance each other)
//   S/N → same   is ideal  (a shared way of perceiving the world)
//   T/F → differ is ideal  (thinker + feeler cover each other's blind spots)
//   J/P → same   is ideal  (shared approach to structure — key for roommates)
// Dimension weights sum to 100; S/N and J/P weigh most for cohabitation.
const MBTI_DIMS = [
  { idx: 0, idealSame: false, weight: 20 }, // E/I
  { idx: 1, idealSame: true,  weight: 30 }, // S/N
  { idx: 2, idealSame: false, weight: 20 }, // T/F
  { idx: 3, idealSame: true,  weight: 30 }, // J/P
];

// Keirsey temperament — the one genuinely well-known MBTI grouping. SJ
// types value order and routine; SP types are easygoing and flexible; NF
// and NT types run on ideas. For COHABITATION (not romance) the steady
// predictor is whether two people approach a shared space the same way.
function temperament(mbti) {
  const t = mbti.trim().toUpperCase();
  if (t[1] === 'S') return t[3] === 'J' ? 'SJ' : 'SP';
  return t[2] === 'F' ? 'NF' : 'NT';
}

// Cohabitation harmony between temperaments (symmetric, 0-100). This is the
// "which types live well together" pairing table — tuned for roommates,
// not romance. SJ (tidy, routine-driven) + SP (relaxed, spontaneous) is the
// classic roommate-friction pairing and scores lowest.
const TEMPERAMENT_HARMONY = {
  SJ: { SJ: 92, SP: 60, NF: 78, NT: 75 },
  SP: { SJ: 60, SP: 85, NF: 72, NT: 70 },
  NF: { SJ: 78, SP: 72, NF: 88, NT: 82 },
  NT: { SJ: 75, SP: 70, NF: 82, NT: 84 },
};

function pairMbti(a, b) {
  const A = a.trim().toUpperCase();
  const B = b.trim().toUpperCase();

  // View 1 — per-dichotomy heuristic (E/I, S/N, T/F, J/P).
  let dichotomy = 0;
  for (const d of MBTI_DIMS) {
    const same  = A[d.idx] === B[d.idx];
    const ideal = same === d.idealSame;
    // Non-ideal still earns half credit — no MBTI combo is a true mismatch.
    dichotomy += ideal ? d.weight : d.weight * 0.5;
  }

  // View 2 — the Keirsey-temperament cohabitation table.
  const temp = TEMPERAMENT_HARMONY[temperament(A)][temperament(B)];

  // Blend evenly — each view catches something the other misses.
  return Math.round(dichotomy * 0.5 + temp * 0.5);
}

// Symmetric DISC pairing matrix on the primary letter. S is the universal
// harmonizer; two same assertive/high-energy styles (D+D) create the most
// friction. These are a readable heuristic, not a measurement.
const DISC_MATRIX = {
  D: { D: 55, I: 80, S: 88, C: 62 },
  I: { D: 80, I: 70, S: 85, C: 60 },
  S: { D: 88, I: 85, S: 90, C: 85 },
  C: { D: 62, I: 60, S: 85, C: 82 },
};

function pairDisc(a, b) {
  const A = a.trim().toUpperCase()[0];
  const B = b.trim().toUpperCase()[0];
  return (DISC_MATRIX[A] && DISC_MATRIX[A][B]) || 70;
}

// Count shared MBTI letters (0-4) — describes the *flavour* of the pairing.
function sharedMbtiLetters(a, b) {
  const A = a.trim().toUpperCase();
  const B = b.trim().toUpperCase();
  let shared = 0;
  for (let i = 0; i < 4; i++) if (A[i] === B[i]) shared += 1;
  return shared;
}

function copyFor(tone) {
  switch (tone) {
    case 'aligned':
      return {
        headline: 'Same wavelength',
        detail:   'You share most of your personality profile — an easy, low-friction pairing where you tend to read situations the same way.',
      };
    case 'complementary':
      return {
        headline: 'Complementary pair',
        detail:   "You're a complementary pair — different enough to balance each other out, with each of you covering the other's blind spots.",
      };
    default:
      return {
        headline: 'Balanced pairing',
        detail:   'A balanced pairing — enough in common to click quickly, enough difference to keep daily life interesting.',
      };
  }
}

/**
 * Compute the personality-pairing readout between two students.
 * Returns { available: false } when neither MBTI nor DISC is known on
 * both sides. Otherwise:
 *   { available: true, score, mbtiPair, discPair, headline, detail, tone }
 */
function computePairing(myMbti, myDisc, theirMbti, theirDisc) {
  const haveMbti = isMbti(myMbti) && isMbti(theirMbti);
  const haveDisc = isDisc(myDisc) && isDisc(theirDisc);
  if (!haveMbti && !haveDisc) return { available: false };

  const mbtiScore = haveMbti ? pairMbti(myMbti, theirMbti) : null;
  const discScore = haveDisc ? pairDisc(myDisc, theirDisc) : null;

  // 60 % MBTI / 40 % DISC when both are known; otherwise whichever exists.
  let score;
  if (haveMbti && haveDisc) score = Math.round(mbtiScore * 0.6 + discScore * 0.4);
  else if (haveMbti)        score = mbtiScore;
  else                      score = discScore;

  // Tone: shared MBTI letters when available, else fall back to the score.
  let tone;
  if (haveMbti) {
    const shared = sharedMbtiLetters(myMbti, theirMbti);
    tone = shared >= 3 ? 'aligned' : shared <= 1 ? 'complementary' : 'balanced';
  } else {
    tone = score >= 84 ? 'aligned' : 'balanced';
  }

  const copy = copyFor(tone);
  return {
    available: true,
    score,
    mbtiPair: haveMbti
      ? `${myMbti.trim().toUpperCase()} + ${theirMbti.trim().toUpperCase()}`
      : null,
    discPair: haveDisc
      ? `${myDisc.trim().toUpperCase()} + ${theirDisc.trim().toUpperCase()}`
      : null,
    headline: copy.headline,
    detail:   copy.detail,
    tone,
  };
}

// ─── Personality MATCH score (the advisor's 60/40 matching input) ────────
//
// Unlike computePairing (a display-only readout), this produces a single
// 0-100 number meant to be BLENDED INTO the real match score. Per the
// advisor's design: 60 % MBTI ("personality") + 40 % DISC & OCEAN
// ("work style"). Returns null when neither side has enough derived
// signal — the caller then falls back to the clinical-quiz score alone.

// OCEAN similarity, 0-100. Closer Big-Five profiles score higher — this
// is the "work style" half of the blend, alongside DISC.
function pairOcean(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return null;
  const keys = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];
  let totalDiff = 0, n = 0;
  for (const k of keys) {
    const va = Number(a[k]);
    const vb = Number(b[k]);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
    totalDiff += Math.abs(va - vb);
    n += 1;
  }
  if (n === 0) return null;
  return Math.round(100 - totalDiff / n);
}

/**
 * Personality match score between two derived profiles, 0-100.
 * Each profile is { mbti, disc, ocean }. Returns null when there isn't
 * enough signal on both sides to say anything meaningful.
 */
function computePersonalityMatch(a, b) {
  if (!a || !b) return null;
  const haveMbti = isMbti(a.mbti) && isMbti(b.mbti);
  const haveDisc = isDisc(a.disc) && isDisc(b.disc);
  const oceanScore = pairOcean(a.ocean, b.ocean);
  if (!haveMbti && !haveDisc && oceanScore === null) return null;

  const mbtiScore = haveMbti ? pairMbti(a.mbti, b.mbti) : null;
  const discScore = haveDisc ? pairDisc(a.disc, b.disc) : null;

  // "Work style" half — DISC + OCEAN, averaged over whatever's present.
  const workParts = [discScore, oceanScore].filter((v) => v !== null);
  const workScore = workParts.length
    ? workParts.reduce((s, v) => s + v, 0) / workParts.length
    : null;

  // 60 % MBTI / 40 % work, when both halves exist; otherwise whichever does.
  if (mbtiScore !== null && workScore !== null) {
    return Math.round(mbtiScore * 0.6 + workScore * 0.4);
  }
  return Math.round(mbtiScore !== null ? mbtiScore : workScore);
}

// ─── Personality-score calibration (for the 30 % match blend) ─────────────
// The heuristic above is intentionally generous — "no MBTI combo is a true
// mismatch" — so its output lives in a high, narrow band (~55-93, centred
// ~72), nothing like the clinical score's spread. Left RAW in the 70/30
// blend, a near-constant ~72 dragged the final match score back toward the
// mean and quietly undid the clinical calibration (see scoring.js). Stretch
// personality around ITS OWN centre (72, not 50) so it actually
// differentiates within the 30 % it owns.
//
// Deliberately GENTLER than the clinical curve (gain 1.5 vs 2.2): MBTI/DISC
// pairing is pop-psychology, not validated science, so we widen it enough to
// matter without faking precision. MONOTONIC → ranking preserved. Constants
// are a first pass — retune against real paired-outcome data alongside the
// clinical GAIN/MID.
const PERS_CAL_GAIN = 1.5;
const PERS_CAL_MID  = 72;
function calibratePersonality(rawPct) {
  if (rawPct === null || !Number.isFinite(rawPct)) return rawPct;
  const stretched = PERS_CAL_MID + (rawPct - PERS_CAL_MID) * PERS_CAL_GAIN;
  return Math.round(Math.min(99, Math.max(5, stretched)));
}

module.exports = { computePairing, computePersonalityMatch, calibratePersonality };
