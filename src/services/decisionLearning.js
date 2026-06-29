// Part 3 — the learning loop.
//
// Every connect / accept / decline is logged to match_decisions with the
// per-category compatibility breakdown captured AT decision time. From that
// history we fit, per user, a small set of category weights: which dimensions
// (lifestyle, communication, …) actually predict THIS person's yeses vs nos.
//
// HONESTY FIRST (same rule as the rest of the engine): when there isn't enough
// real signal, we return null — no model — and the feed keeps its plain
// compatibility order. We never invent a preference from one or two taps. The
// learned model only ever changes the ORDER of a user's own feed; the displayed
// compatibility number stays the honest pairwise score (same for both sides).
//
// The fit is ridge-regularized toward a uniform prior and clamped, so a thin
// history nudges gently and no single category can run away with the ranking.
//
// pool is lazy-required inside the DB functions only, so the pure math
// (fitFromExamples / personalRankScore / uniformPrior) is importable — and
// unit-testable — without the `pg` driver present.

// The category keys services/scoring.js emits in `breakdown`. The model weights
// THESE. Keep in lockstep with CATEGORIES there (lifestyle/communication/
// control/nervous in v8/v9).
const CATEGORY_KEYS = ['lifestyle', 'communication', 'control', 'nervous'];

// ── Ridge / fallback tuning ────────────────────────────────────────────────
const LAMBDA       = 12;   // shrinkage: a weight stays ≈ prior until n ≫ LAMBDA
const GAIN         = 0.8;  // how hard a strong like/dislike contrast moves a weight
const MIN_SAMPLE   = 8;    // fewer total decisions than this → prior (no model)
const MIN_PER_SIDE = 3;    // need ≥3 likes AND ≥3 declines to contrast at all
const CLAMP_LO     = 0.5;  // a learned weight can't fall below 0.5× its prior…
const CLAMP_HI     = 1.5;  // …nor rise above 1.5× — keeps any one category honest

const CACHE_TTL_MS = 10 * 60 * 1000;  // re-fit at most every 10 min per user
const _cache = new Map();             // userId -> { weights|null, at }

function uniformPrior() {
  const p = 1 / CATEGORY_KEYS.length;
  const w = {};
  for (const k of CATEGORY_KEYS) w[k] = p;
  return w;
}

function meanOn(examples, key) {
  let sum = 0, count = 0;
  for (const b of examples) {
    const v = Number(b && b[key]);
    if (Number.isFinite(v)) { sum += v; count++; }
  }
  return count ? sum / count : null;
}

// Pure ridge fit (no DB) — the heart of the learning loop, unit-tested directly.
//   pos = breakdowns of liked decisions (connect/accept)
//   neg = breakdowns of declined decisions
// Returns a weight map summing to 1, or null when there isn't enough contrast.
function fitFromExamples(pos, neg) {
  const n = pos.length + neg.length;
  if (n < MIN_SAMPLE || pos.length < MIN_PER_SIDE || neg.length < MIN_PER_SIDE) {
    return null; // low sample → fall back to the prior (handled by the caller)
  }
  const prior  = uniformPrior();
  const shrink = n / (n + LAMBDA); // →1 with lots of data, →0 when sparse (ridge)
  const raw = {};
  for (const k of CATEGORY_KEYS) {
    const mp = meanOn(pos, k), mn = meanOn(neg, k);
    // signal ∈ [-1,1]: liked-high & disliked-low on this category → positive.
    const signal = (mp != null && mn != null) ? (mp - mn) / 100 : 0;
    let factor = 1 + shrink * GAIN * signal;          // multiplicative around prior
    factor = Math.max(CLAMP_LO, Math.min(CLAMP_HI, factor));
    raw[k] = prior[k] * factor;
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const w = {};
  for (const k of CATEGORY_KEYS) w[k] = raw[k] / total; // renormalize → proper weights
  return w;
}

// Fit a user's category weights from their logged decisions. Returns null when
// the history is too thin to personalize honestly.
async function fitUserCategoryWeights(userId) {
  const pool = require('../db/pool');
  const { rows } = await pool.query(
    `SELECT decision, category_breakdown
       FROM match_decisions
      WHERE user_id = $1 AND category_breakdown IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 500`,
    [userId],
  );
  const pos = [], neg = [];
  for (const r of rows) {
    const b = r.category_breakdown;
    if (!b || typeof b !== 'object') continue;
    if (r.decision === 'connect' || r.decision === 'accept') pos.push(b);
    else if (r.decision === 'decline') neg.push(b);
  }
  return fitFromExamples(pos, neg);
}

// Cached accessor used on the hot feed path. null = no model (don't personalize).
async function getUserCategoryWeights(userId) {
  const hit = _cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.weights;
  let weights = null;
  try {
    weights = await fitUserCategoryWeights(userId);
  } catch (e) {
    console.error('[decisionLearning] fit failed:', e.message);
  }
  _cache.set(userId, { weights, at: Date.now() });
  return weights;
}

// Personalized rank score for one feed row. breakdown is per-category 0-100;
// weights sum to 1 → result is 0-100. Falls back to the row's own compat score
// when the model or breakdown is missing, so ordering degrades gracefully.
function personalRankScore(breakdown, weights, fallback) {
  if (!weights || !breakdown || typeof breakdown !== 'object') return fallback;
  let s = 0, wsum = 0;
  for (const k of CATEGORY_KEYS) {
    const v = Number(breakdown[k]);
    if (Number.isFinite(v)) { s += weights[k] * v; wsum += weights[k]; }
  }
  return wsum > 0 ? s / wsum : fallback;
}

// Append a decision to the learning log. Best-effort — never throws into the
// request path; a logging hiccup must not fail a connect/accept/decline.
async function logDecision(userId, targetUserId, decision, breakdown) {
  if (!['connect', 'accept', 'decline'].includes(decision)) return;
  try {
    const pool = require('../db/pool');
    await pool.query(
      `INSERT INTO match_decisions (user_id, target_user_id, decision, category_breakdown)
       VALUES ($1, $2, $3, $4)`,
      [userId, targetUserId, decision, breakdown ? JSON.stringify(breakdown) : null],
    );
    _cache.delete(userId); // new evidence → drop the stale cached fit
  } catch (e) {
    console.error('[decisionLearning] logDecision failed:', e.message);
  }
}

module.exports = {
  CATEGORY_KEYS,
  uniformPrior,
  fitFromExamples,
  fitUserCategoryWeights,
  getUserCategoryWeights,
  personalRankScore,
  logDecision,
  _clearCache: () => _cache.clear(),
};
