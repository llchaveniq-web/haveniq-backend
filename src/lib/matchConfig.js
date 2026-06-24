// Minimum compatibility score (0-100) for a pair to be SHOWN in the match
// feed AND to be eligible to connect. These are COUPLED on purpose: if a
// student can see a match, they can act on it (otherwise you get "I see them
// but the connect button says compatibility too low").
//
// Env-tunable via MATCH_MIN_SCORE so the floor can be LOWERED for a small /
// cold-start school (a fresh campus with a handful of students would otherwise
// show empty feeds even though real near-matches exist in the 40s) and RAISED
// back toward 50 as the pool grows — all without a code deploy, just a Railway
// variable change + restart.
//
// Default 40 (was a hardcoded 50 everywhere): includes the high-40s near-miss
// band at launch. is_hard_blocked pairs are filtered separately and are NEVER
// shown regardless of this floor.
const MATCH_MIN_SCORE = (() => {
  const n = parseInt(process.env.MATCH_MIN_SCORE, 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 40;
})();

module.exports = { MATCH_MIN_SCORE };
