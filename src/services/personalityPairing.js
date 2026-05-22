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

function pairMbti(a, b) {
  const A = a.trim().toUpperCase();
  const B = b.trim().toUpperCase();
  let score = 0;
  for (const d of MBTI_DIMS) {
    const same  = A[d.idx] === B[d.idx];
    const ideal = same === d.idealSame;
    // Non-ideal still earns half credit — no MBTI combo is a true mismatch.
    score += ideal ? d.weight : d.weight * 0.5;
  }
  return Math.round(score); // ranges 50-100
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

module.exports = { computePairing };
