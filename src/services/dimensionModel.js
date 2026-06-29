// ─── Dimension model store (deep-matching #2) ───────────────────────────────
//
// Trains, certifies, persists, and loads the per-dimension learned shapes that
// scoring.js applies. The math + gate live in services/dimensionBasis.js; this
// module is the outcome plumbing:
//   • PRIOR_DIRECTIONS — which way thin data is allowed to nudge each dimension.
//   • labelOutcome     — turn a pairing_outcomes funnel row into success/fail.
//   • trainDimensionModels — read outcomes, fit+gate each dimension, persist.
//   • loadCertifiedModels  — the certified shapes scoring.js consumes (cached).
//
// SAFETY: with zero labeled outcomes (today), every dimension stays dist-only →
// scoring is unchanged, bit-for-bit. A shape ships ONLY when it earns the gate
// AND its learned type is allowed for that dimension. Complementarity is a
// finding, not an assertion.
//
// pool is lazy-required inside the DB functions so the pure helpers
// (labelOutcome / buildDimensionRecords / PRIOR_DIRECTIONS) import without `pg`.

const { fitDimensionGated, fitProjectionGated } = require('./dimensionBasis');

// Per-dimension priors. `allowedTypes` is the set of NON-similarity shapes the
// gate may certify for that question — everything is similarity (dist-only) by
// default; these say which dimensions are even eligible to flip, matching the
// roommate-conflict priors. `importance` seeds the dist-only prior anchor.
//   50 cleanliness          — similarity + directional (messier roommate drives friction)
//   49 bedtime / 53 focus / 51 substances — similarity only
//   57 chore-initiation / 62 boundaries    — complementarity ALLOWED (initiator+responder)
//   48 hosting / 52 overnight / 54 alcohol — similarity (hard/soft caps stay in scoring.js)
//   14 contempt / 60 repair / 63 repair    — similarity
//   56 money                — similarity
const PRIOR_DIRECTIONS = {
  50: { importance: 1, allowedTypes: ['directional'] },
  49: { importance: 1, allowedTypes: [] },
  53: { importance: 1, allowedTypes: [] },
  51: { importance: 1, allowedTypes: [] },
  57: { importance: 1, allowedTypes: ['complementarity'] },
  62: { importance: 1, allowedTypes: ['complementarity'] },
  48: { importance: 1, allowedTypes: [] },
  52: { importance: 1, allowedTypes: [] },
  54: { importance: 1, allowedTypes: [] },
  14: { importance: 1, allowedTypes: [] },
  60: { importance: 1, allowedTypes: [] },
  63: { importance: 1, allowedTypes: [] },
  56: { importance: 1, allowedTypes: [] },
};

/**
 * Outcome label for a pairing_outcomes row, or null when there's no outcome yet
 * (the row is still in the funnel). Failure signals are checked first: a pair
 * that moved in and THEN changed rooms is a failure, not a success.
 *   success = moved in, and no room change / block / ghost
 *   failure = room change OR block OR ghost
 */
function labelOutcome(row) {
  if (!row) return null;
  if (row.room_change_at || row.blocked_at || row.ghosted_at) return false;
  if (row.moved_in_at) return true;
  return null; // no terminal outcome yet — not a training example
}

/**
 * Turn labeled pairing_outcomes rows into per-dimension training records.
 * Each row's `features.q` is { "<qid>": [aNorm, bNorm] }; we only train the
 * dimensions in PRIOR_DIRECTIONS. Returns { qid: [{a,b,success}] }.
 */
function buildDimensionRecords(rows) {
  const perDim = {};
  for (const qid of Object.keys(PRIOR_DIRECTIONS)) perDim[qid] = [];
  for (const row of rows) {
    const label = labelOutcome(row);
    if (label === null) continue;
    const q = row.features && row.features.q;
    if (!q || typeof q !== 'object') continue;
    for (const qid of Object.keys(PRIOR_DIRECTIONS)) {
      const pair = q[qid];
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const a = Number(pair[0]), b = Number(pair[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      // Deep-matching #6: trajectory snapshot captured at serve time, if present.
      // features.conv[qid] = convergence rate; features.vel[qid] = [vAnorm, vBnorm]
      // (normalized effective velocity / 30d). Absent ⇒ 0 ⇒ no trajectory signal.
      const cm = row.features.conv && row.features.conv[qid];
      const conv = Number.isFinite(Number(cm)) ? Number(cm) : 0;
      const vel = row.features.vel && Array.isArray(row.features.vel[qid]) ? row.features.vel[qid] : null;
      const vA = vel && Number.isFinite(Number(vel[0])) ? Number(vel[0]) : 0;
      const vB = vel && Number.isFinite(Number(vel[1])) ? Number(vel[1]) : 0;
      perDim[qid].push({ a, b, success: label, conv, vA, vB });
    }
  }
  return perDim;
}

/**
 * Read pairing_outcomes, fit + gate each dimension, and upsert dimension_models.
 * Best-effort; returns a per-dimension summary. With no labeled outcomes every
 * dimension lands certified:false → scoring stays on today's curve.
 */
async function trainDimensionModels() {
  const pool = require('../db/pool');
  const { rows } = await pool.query(
    `SELECT features, moved_in_at, room_change_at, blocked_at, ghosted_at
       FROM pairing_outcomes
      WHERE features IS NOT NULL`,
  );
  const perDim = buildDimensionRecords(rows);

  const summary = [];
  for (const [qid, cfg] of Object.entries(PRIOR_DIRECTIONS)) {
    const records = perDim[qid] || [];
    const shape = fitDimensionGated(records, {
      importance: cfg.importance,
      allowedTypes: cfg.allowedTypes,
    });
    // Deep-matching #6 projection gate: a dimension scores on velocity-projected
    // values ONLY if that beats the snapshot on held-out outcomes. Projection
    // only matters once the dimension's shape is certified (otherwise scoring is
    // dist-only anyway), so gate it there. Off by default ⇒ snapshot-only today.
    let project = false, projReason = 'projection not evaluated (shape uncertified)';
    if (shape.certified) {
      const pg = fitProjectionGated(records, { importance: cfg.importance });
      project = pg.project; projReason = pg.reason;
    }
    const stored = shape.certified
      ? { baseline: shape.baseline, basis: shape.basis }
      : null;
    try {
      await pool.query(
        `INSERT INTO dimension_models (qid, type, certified, project, n, auc, shape, reason, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (qid) DO UPDATE
           SET type = EXCLUDED.type, certified = EXCLUDED.certified, project = EXCLUDED.project,
               n = EXCLUDED.n, auc = EXCLUDED.auc, shape = EXCLUDED.shape, reason = EXCLUDED.reason,
               updated_at = NOW()`,
        [Number(qid), shape.type, shape.certified, project, shape.n,
         Number.isFinite(shape.auc) ? shape.auc : null,
         stored ? JSON.stringify(stored) : null, `${shape.reason}; ${projReason}`],
      );
    } catch (e) {
      console.error(`[dimensionModel] persist qid=${qid} failed:`, e.message);
    }
    summary.push({ qid: Number(qid), type: shape.type, certified: shape.certified, project, n: shape.n, auc: shape.auc });
  }
  return summary;
}

// Small in-process cache; certified shapes change at most when training runs.
const CACHE_TTL_MS = 10 * 60 * 1000;
let _cache = null;
let _cacheAt = 0;

/**
 * The certified shapes scoring.js applies, keyed by qid:
 *   { "57": { certified:true, type, baseline, basis }, … }
 * Only certified rows are returned — an uncertified dimension simply isn't in
 * the map, so the scorer keeps today's curve. Errors → {} (cold-start).
 */
async function loadCertifiedModels({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;
  const out = {};
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      `SELECT qid, type, project, shape FROM dimension_models WHERE certified = TRUE AND shape IS NOT NULL`,
    );
    for (const r of rows) {
      if (!r.shape || !r.shape.baseline || !r.shape.basis) continue;
      out[r.qid] = { certified: true, type: r.type, project: !!r.project, baseline: r.shape.baseline, basis: r.shape.basis };
    }
  } catch (e) {
    console.error('[dimensionModel] load failed:', e.message);
    return {}; // safe: cold-start
  }
  _cache = out;
  _cacheAt = Date.now();
  return out;
}

module.exports = {
  PRIOR_DIRECTIONS,
  labelOutcome,
  buildDimensionRecords,
  trainDimensionModels,
  loadCertifiedModels,
  _clearCache: () => { _cache = null; _cacheAt = 0; },
};
