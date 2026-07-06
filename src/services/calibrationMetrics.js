// ═══════════════════════════════════════════════════════════════════════════
//  Calibration quality metrics + public-proof headline — Phase 4.
//
//  PURE (no DB). Two honest questions:
//   1. "Is the engine improving?" — Brier score + AUC of predicted-score vs the
//      real worked/failed outcome, tracked over time on an admin route.
//   2. "Can we say it publicly?" — an honest headline derived from the
//      calibration curve, gated on a HIGHER sample bar than the in-app screen,
//      and NEVER fabricated: below the bar (or without a real spread) it returns
//      { ok:false } and no number is shown.
// ═══════════════════════════════════════════════════════════════════════════

// Public claims need more evidence than the in-app "still gathering" gate (30).
const PUBLIC_MIN_SAMPLE = 50;
// Each ANCHOR band (the top + the reference) must carry at least this many
// outcomes before it can anchor a public "N× more often" claim. Without it, a
// cohort that clears the total-sample floor could still compute the multiple off
// a 1–3 person band — statistical noise that would flip the moment one more
// outcome lands. A per-band floor keeps the headline credible, not just present.
const PUBLIC_MIN_BAND = 10;

// Brier score: mean squared error of a probability forecast. Lower is better
// (0 = perfect, 0.25 = a coin flip). points: [{ p:0..1, y:0|1 }].
function brierScore(points) {
  const pts = (points || []).filter((d) => Number.isFinite(d.p) && (d.y === 0 || d.y === 1));
  if (!pts.length) return null;
  let s = 0;
  for (const d of pts) s += (d.p - d.y) ** 2;
  return s / pts.length;
}

// AUC via the Mann-Whitney U statistic (probability a random worked pair was
// scored higher than a random failed one). 0.5 = no better than chance. Handles
// ties at 0.5 credit. Needs both classes present, else null.
function auc(points) {
  const pts = (points || []).filter((d) => Number.isFinite(d.p) && (d.y === 0 || d.y === 1));
  const pos = pts.filter((d) => d.y === 1);
  const neg = pts.filter((d) => d.y === 0);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) {
    for (const b of neg) {
      if (a.p > b.p) wins += 1;
      else if (a.p === b.p) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

// Are the bands monotonically improving high→low? The single most important
// internal signal — a well-calibrated engine shows success rising with the band.
function isMonotonic(bandsHighToLow) {
  const b = (bandsHighToLow || []).filter((x) => Number.isFinite(x.actualSuccess));
  for (let i = 1; i < b.length; i++) {
    if (b[i].actualSuccess > b[i - 1].actualSuccess) return false;
  }
  return b.length >= 2;
}

// Public-proof headline from the calibration bands. Honest by construction:
//   - requires totalSample >= PUBLIC_MIN_SAMPLE (higher than the in-app 30),
//   - requires BOTH anchor bands (top + reference) to hold >= PUBLIC_MIN_BAND
//     outcomes, so "N× more often" is never computed off a 1–3 person band,
//   - requires the top band to actually beat the reference (never spin a
//     null/negative result into a claim).
// Returns { ok:true, headline, multiple, topBand, referenceBand, totalSample }
// or { ok:false }.
function publicHeadline({ totalSample, bands } = {}, { minSample = PUBLIC_MIN_SAMPLE, minBand = PUBLIC_MIN_BAND } = {}) {
  if (!Array.isArray(bands) || !bands.length) return { ok: false };
  if (!Number.isFinite(totalSample) || totalSample < minSample) return { ok: false };

  const sorted = [...bands]
    .filter((b) => Number.isFinite(b.actualSuccess) && Number.isFinite(b.sampleSize) && b.sampleSize > 0)
    .sort((a, b) => b.min - a.min);
  if (sorted.length < 2) return { ok: false };

  const top = sorted[0];
  const reference = sorted[sorted.length - 1];
  // Both anchors must carry real weight and the reference must have a nonzero
  // base rate to form an honest multiple.
  // Both anchors must hold real weight — a 1–3 person band is noise, not proof.
  if (top.sampleSize < minBand || reference.sampleSize < minBand) return { ok: false };
  if (!(reference.actualSuccess > 0)) return { ok: false };
  const multiple = top.actualSuccess / reference.actualSuccess;
  if (!(multiple > 1)) return { ok: false }; // no real lift → no claim

  const nx = Math.round(multiple * 10) / 10;
  return {
    ok: true,
    headline: `Students we matched at ${top.band} chose to keep living together `
      + `${nx}× more often than our lowest-confidence matches.`,
    multiple: nx,
    topBand: top,
    referenceBand: reference,
    totalSample,
  };
}

module.exports = { PUBLIC_MIN_SAMPLE, PUBLIC_MIN_BAND, brierScore, auc, isMonotonic, publicHeadline };
