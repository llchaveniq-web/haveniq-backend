// ═══════════════════════════════════════════════════════════════════════════
//  Data-refresh diff report — the Watch loop for the housing "best time to look"
//  coverage. After a source refresh (ZORI / HUD FMR / ACS ingest), recompute how
//  every school resolves (city / metro / county / 404) and the typical-rent
//  level, compare against the last stored snapshot, and write a diff report:
//  what newly resolves, what newly 404s, what REGRESSED, and the biggest rent
//  moves. Anomalies (a regression, an implausible rent jump, a board-wide
//  coverage drop) are flagged for a human; a routine refresh with no material
//  change is silent.
//
//  Honesty, hard rules:
//   - No synthetic deltas: the diff is computed from a REAL recompute against
//     real ingested data; if the timing store is empty the run yields nothing,
//     not a fabricated report.
//   - The honest 404 is preserved — a school with no authoritative data stays
//     404; a regression TO 404 is real information, surfaced, never backfilled
//     with a guess or nearest-neighbour estimate.
//   - First run with no prior snapshot → "baseline established", not a diff.
//
//  Pure compute (computeCoverage / diffSnapshots) is unit-tested without a DB.
// ═══════════════════════════════════════════════════════════════════════════

const poolDefault = require('../db/pool');
const ht = require('./housingTiming');
const sentry = require('../utils/sentry');

// Coverage quality ordering. A move to a LOWER rank is a regression.
const LEVEL_RANK = { city: 3, metro: 2, county: 1, '404': 0 };

// Shared reader: a BLANK env var falls back to the guardrail, not to 0 —
// Number('') is 0, which would silently zero a safety threshold.
const { envNum: num } = require('../lib/envNum');
function thresholds(over = {}) {
  return {
    rentMove:    num(process.env.WATCH_COVERAGE_RENT_MOVE, 0.10),     // material MoM move
    rentAnomaly: num(process.env.WATCH_COVERAGE_RENT_ANOMALY, 0.40),  // implausible one-refresh jump
    boardDrop:   num(process.env.WATCH_COVERAGE_BOARD_DROP, 0.05),    // fraction of resolved lost = board drop
    ...over,
  };
}

const rentOf = (timing) => (timing && Number.isFinite(Number(timing.typicalRent)) ? Number(timing.typicalRent) : null);

// Resolve ONE school's coverage from its resolveHousing() output + the in-memory
// timing map, mirroring the /housing/timing route precedence EXACTLY:
// ZORI city (seasonal) → ZORI metro (seasonal) → HUD county (level) → 404.
function coverageForResolution(r, timingMap, normKey) {
  if (!r) return { level: '404', rent: null };
  const z = r.zori;
  if (z && z.city) {
    const t = timingMap.get('city:' + normKey(z.city));
    if (t) return { level: 'city', rent: rentOf(t) };
  }
  if (z && z.short) {
    const t = timingMap.get(normKey(z.short));
    if (t) return { level: 'metro', rent: rentOf(t) };
  }
  if (r.fips) {
    const t = timingMap.get('county:' + r.fips);
    if (t) return { level: 'county', rent: rentOf(t) };
  }
  return { level: '404', rent: null }; // honest 404 — no backfill, no guess
}

// Recompute coverage across ALL schools in the crosswalk (keyed by stable .edu
// domain). `resolver` defaults to the real housingTiming; injectable for tests.
// Returns { totals, schools:{ domain:{ l, r } } }.
function computeCoverage(timingMap, resolver = ht) {
  const bundle = resolver.loadBundle ? resolver.loadBundle() : require('../data/housingCrosswalk.json');
  const normKey = resolver.normalizeRegionKey;
  const domains = Object.keys(bundle.byDomain || {});
  const schools = {};
  const totals = { city: 0, metro: 0, county: 0, notResolved: 0, total: domains.length };
  for (const domain of domains) {
    const r = resolver.resolveHousing({ domain });
    const { level, rent } = coverageForResolution(r, timingMap, normKey);
    schools[domain] = { l: level, r: rent };
    if (level === '404') totals.notResolved += 1;
    else totals[level] += 1;
  }
  return { totals, schools };
}

// Diff two per-school maps. Pure. Returns the report pieces + the flagged
// anomalies (regressions + implausible jumps). `boardDrop` handled by caller.
function diffSnapshots(prev, curr, th = thresholds()) {
  const newlyResolves = [], newly404s = [], regressions = [], rentMoves = [];
  const domains = new Set([...Object.keys(prev || {}), ...Object.keys(curr || {})]);
  for (const domain of domains) {
    const a = prev[domain], b = curr[domain];
    if (!a || !b) continue; // only compare schools present in BOTH snapshots
    const ra = LEVEL_RANK[a.l], rb = LEVEL_RANK[b.l];
    if (a.l === '404' && b.l !== '404') newlyResolves.push({ domain, to: b.l });
    if (a.l !== '404' && b.l === '404') newly404s.push({ domain, from: a.l });
    if (rb < ra) regressions.push({ domain, from: a.l, to: b.l }); // any downgrade (incl → 404)
    if (Number.isFinite(a.r) && Number.isFinite(b.r) && a.r > 0) {
      const pct = (b.r - a.r) / a.r;
      if (Math.abs(pct) >= th.rentMove) {
        rentMoves.push({ domain, oldRent: a.r, newRent: b.r, pct: Math.round(pct * 1000) / 1000, fromLevel: a.l, toLevel: b.l });
      }
    }
  }
  rentMoves.sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));

  // Anomalies a human must look at: any regression, plus rent jumps beyond the
  // implausible threshold. Regressions to 404 are the highest-signal ones.
  const anomalies = [];
  for (const g of regressions) {
    anomalies.push({ kind: 'regression', domain: g.domain, detail: `${g.from} → ${g.to}`, severity: g.to === '404' ? 'high' : 'medium' });
  }
  for (const m of rentMoves) {
    if (Math.abs(m.pct) >= th.rentAnomaly) {
      anomalies.push({ kind: 'rent_jump', domain: m.domain, detail: `${m.oldRent} → ${m.newRent} (${Math.round(m.pct * 100)}%)`, severity: 'high' });
    }
  }
  return { newlyResolves, newly404s, regressions, rentMoves, anomalies };
}

// Board-wide coverage drop: resolved count fell by more than the threshold
// fraction in a single refresh — a whole-source failure, not a few schools.
function boardCoverageDrop(prevTotals, currTotals, frac) {
  const prevResolved = (prevTotals.total || 0) - (prevTotals.notResolved || 0);
  const currResolved = (currTotals.total || 0) - (currTotals.notResolved || 0);
  if (prevResolved <= 0) return null;
  const dropped = prevResolved - currResolved;
  if (dropped > 0 && dropped / prevResolved >= frac) {
    return { kind: 'board_coverage_drop', detail: `resolved ${prevResolved} → ${currResolved} (-${Math.round((dropped / prevResolved) * 100)}%)`, severity: 'high' };
  }
  return null;
}

// ── DB snapshot store (soft-fails) ──────────────────────────────────────────
async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coverage_snapshots (
      id            BIGSERIAL PRIMARY KEY,
      totals        JSONB NOT NULL,
      schools       JSONB NOT NULL,      -- { domain: { l, r } } — the per-school state
      diff          JSONB,               -- the report vs the previous snapshot (null on baseline)
      anomaly_count INT NOT NULL DEFAULT 0,
      baseline      BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_coverage_snapshots_time ON coverage_snapshots(created_at DESC);
  `).catch((e) => console.error('[coverage-diff] ensure table:', e.message));
}

async function getLatest(pool) {
  try {
    const { rows } = await pool.query('SELECT * FROM coverage_snapshots ORDER BY created_at DESC LIMIT 1');
    return rows[0] || null;
  } catch (e) { console.error('[coverage-diff] getLatest:', e.message); return null; }
}

async function pruneOld(pool, keep = 12) {
  try {
    await pool.query(
      `DELETE FROM coverage_snapshots WHERE id NOT IN (
         SELECT id FROM coverage_snapshots ORDER BY created_at DESC LIMIT $1)`, [keep]);
  } catch (e) { console.error('[coverage-diff] prune:', e.message); }
}

// The Discord page — ONLY when this refresh introduced anomalies (a transition,
// since the diff is against the last snapshot). Best-effort.
async function pageAnomaly(report, fetchImpl) {
  const hook = process.env.DISCORD_WEBHOOK_URL || '';
  try { sentry.captureError(new Error('signal:data_coverage_anomaly'), { count: report.anomalies.length }); } catch { /* best-effort */ }
  if (!hook) return;
  const top = report.anomalies.slice(0, 8).map((a) => `• [${a.severity}] ${a.kind} — ${a.domain || ''} ${a.detail}`).join('\n');
  const f = fetchImpl || fetch;
  await f(hook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🟠 signal:data_coverage_anomaly',
        description: `A data refresh flagged **${report.anomalies.length}** anomaly(ies) for review — nothing was auto-published as good.\n${top}`.slice(0, 1900),
        color: 0xE67E22,
        timestamp: report.at || new Date().toISOString(),
        footer: { text: 'Watch loop • housing coverage diff • review GET /ops/data-diff' },
      }],
    }),
  }).catch(() => {});
}

// Load every stored timing row into an in-memory map (region_key → timing) so
// the 5k-school recompute is one query, not 5k.
async function loadTimingMap(pool) {
  const { rows } = await pool.query('SELECT region_key, timing FROM housing_timing');
  const map = new Map();
  for (const row of rows) map.set(row.region_key, row.timing);
  return map;
}

// The orchestrator. Injectable for tests. Recompute → compare → store → (maybe)
// page. Never throws into the scheduler.
async function runCoverageDiff(opts = {}) {
  const pool = opts.pool || poolDefault;
  const resolver = opts.resolver || ht;
  const alert = opts.alert || pageAnomaly;
  const th = thresholds(opts.thresholds);
  const nowIso = opts.now || new Date().toISOString();

  await ensureTable(pool);

  let timingMap;
  try { timingMap = opts.timingMap || await loadTimingMap(pool); }
  catch (e) { console.error('[coverage-diff] timing load failed:', e.message); return { ok: false, reason: 'timing_unavailable' }; }

  // No authoritative data at all → nothing honest to snapshot. Not a report.
  if (timingMap.size === 0) return { ok: false, reason: 'no_timing_data' };

  const { totals, schools } = computeCoverage(timingMap, resolver);
  const prev = await getLatest(pool);

  // First run → baseline, no diff, no alert.
  if (!prev) {
    await insertSnapshot(pool, { totals, schools, diff: null, anomalyCount: 0, baseline: true });
    return { ok: true, baseline: true, totals };
  }

  const prevSchools = prev.schools || {};
  const report = diffSnapshots(prevSchools, schools, th);
  const board = boardCoverageDrop(prev.totals || {}, totals, th.boardDrop);
  if (board) report.anomalies.push(board);
  report.at = nowIso;

  await insertSnapshot(pool, { totals, schools, diff: report, anomalyCount: report.anomalies.length, baseline: false });
  await pruneOld(pool);

  // Fire only when this refresh introduced anomalies (transition by construction).
  if (report.anomalies.length > 0) await alert(report);

  return {
    ok: true, baseline: false, totals,
    changed: {
      newlyResolves: report.newlyResolves.length,
      newly404s: report.newly404s.length,
      regressions: report.regressions.length,
      materialRentMoves: report.rentMoves.length,
      anomalies: report.anomalies.length,
    },
  };
}

async function insertSnapshot(pool, s) {
  return pool.query(
    `INSERT INTO coverage_snapshots (totals, schools, diff, anomaly_count, baseline)
     VALUES ($1,$2,$3,$4,$5)`,
    [JSON.stringify(s.totals), JSON.stringify(s.schools), s.diff ? JSON.stringify(s.diff) : null, s.anomalyCount, s.baseline],
  ).catch((e) => console.error('[coverage-diff] insert:', e.message));
}

// Read side for GET /ops/data-diff — the latest report (soft-fails to null).
async function latestReport(pool) {
  const row = await getLatest(pool);
  if (!row) return null;
  return {
    at: row.created_at, baseline: row.baseline, totals: row.totals,
    anomalyCount: row.anomaly_count, diff: row.diff || null,
  };
}

module.exports = {
  LEVEL_RANK, thresholds, coverageForResolution, computeCoverage, diffSnapshots,
  boardCoverageDrop, runCoverageDiff, latestReport, pageAnomaly, loadTimingMap, ensureTable,
};
