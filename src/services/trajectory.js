// ─── Trajectory / velocity helpers (deep-matching #6) ───────────────────────
//
// Scoring is otherwise snapshot-blind: it scores the point-in-time answer and
// ignores where the habit is heading. The app already computes per-question
// velocity (least-squares slope in answer-units per 30 days) and posts it as
// pulse_drift; these helpers turn that into (1) a forward PROJECTION of a value
// to a horizon and (2) a CONVERGENCE rate between two users' trajectories.
//
// SAFETY: every helper is a strict no-op without reliable drift. No drift, fewer
// than 3 samples, or a 'stable' trend ⇒ effective velocity 0 ⇒ projection equals
// the current value and convergence equals 0. New students and anyone who hasn't
// done a pulse check-in are scored exactly as today, bit-for-bit.
//
// Pure, deterministic, dependency-free. We never recompute velocity — the app
// owns the baseline anchor + answer→value normalization; we trust its value.

const HORIZON_DEFAULT_DAYS = 90;
const MIN_SAMPLES = 3;

/**
 * Confidence in a drift signal ∈ [0,1]. 0 means "do not project": fewer than
 * MIN_SAMPLES points or a 'stable'/unknown trend. Otherwise it grows with
 * sampleSize (0.5 at 3 → 1.0 by 10) and trusts a settled 'changed' move fully
 * while discounting a still-'shifting' one — so a single noisy jump barely moves
 * the score, and a large settled move is believed.
 */
function reliability(d) {
  if (!d) return 0;
  const ss = Number(d.sampleSize);
  if (!Number.isFinite(ss) || ss < MIN_SAMPLES) return 0;
  if (d.trend !== 'shifting' && d.trend !== 'changed') return 0; // 'stable'/null → no projection
  const n = 0.5 + 0.5 * Math.min(1, (ss - MIN_SAMPLES) / 7);     // 0.5 @3 → 1.0 @10+
  const t = d.trend === 'changed' ? 1 : 0.6;                     // 'shifting' trusted less
  return n * t;
}

/**
 * Effective velocity = the app's velocity scaled by our confidence in it.
 * 0 when not projectable (cold-start / unreliable). Units: answer-units / 30d.
 */
function effectiveVelocity(d) {
  const v = d && Number(d.velocity);
  if (!Number.isFinite(v)) return 0;
  return reliability(d) * v;
}

/**
 * Project an option index forward to `horizonDays`, clamped to [0, maxIdx].
 * velocity is in option-index units per 30 days. No reliable drift ⇒ returns
 * `idx` unchanged (bit-for-bit today).
 */
function projectIndex(idx, d, horizonDays, maxIdx) {
  const ve = effectiveVelocity(d);
  if (ve === 0) return idx;
  const H = Number.isFinite(horizonDays) && horizonDays > 0 ? horizonDays : HORIZON_DEFAULT_DAYS;
  const projected = idx + ve * (H / 30);
  return Math.min(maxIdx, Math.max(0, projected));
}

/**
 * Convergence rate on a dimension from the two users' drift. Positive ⇒ the gap
 * is CLOSING (d|a−b|/dt < 0), negative ⇒ widening, 0 ⇒ neither is moving (so it
 * is exactly 0 at cold-start). Uses the CURRENT positions for the gap sign and
 * the effective velocities for the rate, normalized by the option range to sit
 * on the same ~unit scale as the other basis features, clamped to [-1, 1].
 */
function convergence(aIdx, bIdx, dA, dB, maxIdx) {
  const vA = effectiveVelocity(dA), vB = effectiveVelocity(dB);
  if (vA === 0 && vB === 0) return 0;          // cold-start ⇒ exactly 0
  const s = Math.sign(aIdx - bIdx);            // 0 when the pair already agrees
  const dGap = s * (vA - vB);                  // d|a−b|/dt  (answer-units / 30d)
  const conv = -dGap;                          // closing ⇒ positive
  const den = Math.max(1, maxIdx);
  return Math.max(-1, Math.min(1, conv / den));
}

// Map a free-text move-in timeline ('1 month' / '2 months' / 'This semester' …)
// to a horizon in days. Falls back to the fixed 90-day horizon when unknown.
function horizonFromMoveIn(moveInTimeline) {
  if (typeof moveInTimeline === 'string') {
    const m = moveInTimeline.match(/(\d+)\s*month/i);
    if (m) {
      const months = Number(m[1]);
      if (Number.isFinite(months) && months > 0) return Math.min(365, months * 30);
    }
  }
  return HORIZON_DEFAULT_DAYS;
}

module.exports = {
  HORIZON_DEFAULT_DAYS,
  MIN_SAMPLES,
  reliability,
  effectiveVelocity,
  projectIndex,
  convergence,
  horizonFromMoveIn,
};
