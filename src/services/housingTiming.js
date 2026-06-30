// ─── Housing-timing pipeline (LEGAL — published data, no scraping) ──────────
//
// We never touch a Zillow/Apartments.com *listing page* (that's a ToS/legal
// risk). We ingest Zillow Research's PUBLIC, free ZORI rent-index CSVs
// (zillow.com/research/data) — multi-year monthly rent per metro — and compute,
// per metro, a "best time to lock in" from the seasonal pattern. Optional public
// HUD/Census signals can layer in later; this module is structured for it.
//
// The compute is pure + deterministic (unit-tested). The DB/network functions
// lazy-require pool so the pure helpers import without `pg`.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const SOURCE = 'Zillow Research (ZORI)';
// Stable public ZORI metro CSV. Zillow occasionally renames these — override via
// env if the path moves; ingest fails gracefully (logs, no data) if it 404s.
const DEFAULT_ZORI_URL =
  'https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv';

// ── CSV ──────────────────────────────────────────────────────────────────────
// Minimal RFC-4180-ish line parser: handles double-quoted fields that contain
// commas (ZORI's RegionName is "City, ST") and escaped quotes ("").
function parseCsvLine(line) {
  const out = [];
  let field = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

const isDateCol = (h) => /^\d{4}-\d{2}-\d{2}$/.test(h);

/**
 * Parse a ZORI CSV into per-region monthly rent series.
 * Returns [{ regionName, regionType, state, series: [{ period:'YYYY-MM-01', rent:Number }] }].
 * Tolerates blank cells (a region with no value that month is skipped).
 */
function parseZoriCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const col = (name) => header.indexOf(name);
  const iName = col('RegionName'), iType = col('RegionType'), iState = col('StateName');
  if (iName < 0) return [];
  const dateCols = header.map((h, idx) => (isDateCol(h) ? { idx, period: `${h.slice(0, 7)}-01` } : null)).filter(Boolean);
  if (dateCols.length === 0) return [];

  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = parseCsvLine(lines[r]);
    const regionName = cells[iName];
    if (!regionName) continue;
    const series = [];
    for (const dc of dateCols) {
      const raw = cells[dc.idx];
      if (raw === undefined || raw === '') continue;
      const rent = Number(raw);
      if (Number.isFinite(rent) && rent > 0) series.push({ period: dc.period, rent });
    }
    if (series.length === 0) continue;
    out.push({
      regionName,
      regionType: iType >= 0 ? (cells[iType] || null) : null,
      state: iState >= 0 ? (cells[iState] || null) : null,
      series,
    });
  }
  return out;
}

// ── Seasonality ──────────────────────────────────────────────────────────────
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Compute the seasonal "best time to lock in" for one metro from its monthly
 * rent series (ratio-to-centered-moving-average decomposition). Returns the
 * compact timing object, or null when there isn't enough data (< 24 months) —
 * the caller then has nothing to serve and the endpoint 404s.
 *
 * series: [{ period:'YYYY-MM-01', rent:Number }] (any order).
 */
function computeSeasonality(series) {
  if (!Array.isArray(series) || series.length < 24) return null;
  const s = [...series].sort((a, b) => a.period.localeCompare(b.period));
  const v = s.map(x => Number(x.rent));
  const m = s.map(x => Number(x.period.slice(5, 7)) - 1); // 0-11
  const n = v.length;

  // Centered 13-term moving average (half weight on the ends) — the standard
  // detrend for monthly seasonal decomposition. ratio = actual / trend.
  const byMonth = Array.from({ length: 12 }, () => []);
  for (let i = 6; i <= n - 7; i++) {
    let sum = 0.5 * v[i - 6] + 0.5 * v[i + 6];
    for (let k = -5; k <= 5; k++) sum += v[i + k];
    const trend = sum / 12;
    if (trend > 0) byMonth[m[i]].push(v[i] / trend);
  }

  // Average ratio per calendar month → seasonal factor, normalized to mean 1.
  const raw = byMonth.map(arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null));
  const present = raw.filter(x => x !== null);
  if (present.length < 6) return null; // too sparse to be honest about
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  const factor = raw.map(x => (x === null ? 1 : x / mean));

  const min = Math.min(...factor), max = Math.max(...factor);
  const swingPct = Math.round((max - min) * 100);

  // Cheapest months to lock in = lowest seasonal factors (below average first).
  const ranked = factor
    .map((f, idx) => ({ idx, f }))
    .filter(x => raw[x.idx] !== null)
    .sort((a, b) => a.f - b.f);
  const below = ranked.filter(x => x.f < 1);
  const pick = (below.length >= 2 ? below : ranked).slice(0, 3);
  const bestMonthsToSearch = pick.map(x => MONTHS[x.idx]);

  // Lead time is a GUIDELINE, not a precise figure: the bigger the seasonal
  // swing, the earlier you lock in to catch the trough. Kept in a sane range.
  const leadTimeWeeks = clamp(Math.round(4 + swingPct / 3), 4, 10);

  const asOf = s[s.length - 1].period.slice(0, 7); // YYYY-MM

  return {
    bestMonthsToSearch,
    expectedSeasonalSwing: `${swingPct}%`,
    leadTimeWeeks,
    asOf,
    source: SOURCE,
  };
}

// ── Region keys + school→metro resolution ────────────────────────────────────
function normalizeRegionKey(name) {
  return String(name || '')
    .trim().toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Curated overrides for schools whose campus city isn't the ZORI metro name
// (e.g. Fullerton/Irvine roll up into the Los Angeles MSA). Launch-focused
// (California) — extend as new schools come online. Unknown schools fall through
// to a substring-city match, then to 404 (the app degrades to reasoned guidance).
const CURATED_SCHOOL_METRO = {
  'california state university, fullerton': 'Los Angeles, CA',
  'cal state fullerton':                   'Los Angeles, CA',
  'university of california, irvine':       'Los Angeles, CA',
  'uc irvine':                             'Los Angeles, CA',
  'university of california, los angeles':  'Los Angeles, CA',
  'ucla':                                  'Los Angeles, CA',
  'university of southern california':      'Los Angeles, CA',
  'usc':                                   'Los Angeles, CA',
  'california state university, northridge':'Los Angeles, CA',
  'csun':                                  'Los Angeles, CA',
  'university of california, riverside':    'Riverside, CA',
  'uc riverside':                          'Riverside, CA',
  'university of san diego':               'San Diego, CA',
  'san diego state university':            'San Diego, CA',
  'university of california, san diego':    'San Diego, CA',
  'uc san diego':                          'San Diego, CA',
  'university of california, berkeley':     'San Francisco, CA',
  'uc berkeley':                           'San Francisco, CA',
  'stanford university':                   'San Jose, CA',
  'san jose state university':             'San Jose, CA',
  'university of california, davis':        'Sacramento, CA',
  'uc davis':                              'Sacramento, CA',
  'california polytechnic state university':'San Luis Obispo, CA',
  'cal poly san luis obispo':              'San Luis Obispo, CA',
  'university of california, santa barbara':'Santa Barbara, CA',
  'uc santa barbara':                      'Santa Barbara, CA',
};

/**
 * Resolve a school name to a ZORI region NAME ("City, ST"), best-effort:
 *   1. curated override,
 *   2. the school string contains a known region's city (e.g. "San Diego State"
 *      → "San Diego, CA"), preferring the longest city match.
 * `regionNames` = the region names we actually have data for (so we never
 * resolve to a metro with no data). Returns null when unresolved → caller 404s.
 */
function resolveSchoolToMetro(school, regionNames = []) {
  const norm = normalizeRegionKey(school);
  if (!norm) return null;
  const have = new Set(regionNames);
  if (have.size === 0) return null; // no data held → nothing honest to resolve to
  const curated = CURATED_SCHOOL_METRO[String(school || '').trim().toLowerCase()];
  if (curated && have.has(curated)) return curated;

  // Substring-city match: "san diego state university" includes "san diego".
  let best = null;
  for (const region of regionNames) {
    const city = String(region).split(',')[0].trim().toLowerCase();
    if (!city) continue;
    const cityKey = normalizeRegionKey(city);
    if (norm.includes(cityKey) && (!best || cityKey.length > best.key.length)) {
      best = { region, key: cityKey };
    }
  }
  return best ? best.region : null;
}

// ── DB / network (lazy pool) ─────────────────────────────────────────────────
// Keep at most this many recent months per region — enough years for robust
// seasonality without storing the full multi-decade history.
const KEEP_MONTHS = 72;

async function ingestZori({ url } = {}) {
  const pool = require('../db/pool');
  const csvUrl = url || process.env.ZORI_METRO_CSV_URL || DEFAULT_ZORI_URL;
  let regions;
  try {
    const res = await fetch(csvUrl, { headers: { 'user-agent': 'haveniq-housing-ingest/1' } });
    if (!res.ok) return { ok: false, reason: `download ${res.status}`, url: csvUrl };
    regions = parseZoriCsv(await res.text());
  } catch (e) {
    return { ok: false, reason: `download failed: ${e.message}`, url: csvUrl };
  }
  if (!regions.length) return { ok: false, reason: 'no regions parsed', url: csvUrl };

  let upserted = 0;
  for (const reg of regions) {
    const key = normalizeRegionKey(reg.regionName);
    const recent = reg.series.slice(-KEEP_MONTHS);
    // Batch the recent months for this region in one statement.
    const values = recent
      .map((_, i) => `($1,$2,$3,$4,$${i * 2 + 5}::date,$${i * 2 + 6}::numeric,$${5 + recent.length * 2})`)
      .join(',');
    const params = [key, reg.regionName, reg.regionType || 'metro', reg.state];
    for (const pt of recent) params.push(pt.period, pt.rent);
    params.push(SOURCE);
    try {
      await pool.query(
        `INSERT INTO housing_rent_index (region_key, region_name, region_type, state, period, rent, source)
         VALUES ${values}
         ON CONFLICT (region_key, region_type, period)
         DO UPDATE SET rent = EXCLUDED.rent, region_name = EXCLUDED.region_name,
                       state = EXCLUDED.state, source = EXCLUDED.source, ingested_at = NOW()`,
        params,
      );
      upserted += recent.length;
    } catch (e) {
      console.error(`[housing] upsert ${key} failed:`, e.message);
    }
  }
  const computed = await computeAndStoreTiming();
  return { ok: true, regions: regions.length, rowsUpserted: upserted, computed };
}

// Recompute timing for every region we have rent data for; store in housing_timing.
async function computeAndStoreTiming() {
  const pool = require('../db/pool');
  const { rows } = await pool.query(
    `SELECT region_key, region_name, region_type, state, period, rent
       FROM housing_rent_index ORDER BY region_key, period`);
  const byRegion = new Map();
  for (const r of rows) {
    const g = byRegion.get(r.region_key) || { meta: r, series: [] };
    g.series.push({ period: (r.period instanceof Date ? r.period.toISOString().slice(0, 10) : String(r.period).slice(0, 10)), rent: Number(r.rent) });
    byRegion.set(r.region_key, g);
  }
  let computed = 0;
  for (const [key, g] of byRegion) {
    const timing = computeSeasonality(g.series);
    if (!timing) continue;
    try {
      await pool.query(
        `INSERT INTO housing_timing (region_key, region_name, region_type, state, timing, computed_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (region_key) DO UPDATE
           SET region_name = EXCLUDED.region_name, region_type = EXCLUDED.region_type,
               state = EXCLUDED.state, timing = EXCLUDED.timing, computed_at = NOW()`,
        [key, g.meta.region_name, g.meta.region_type, g.meta.state, JSON.stringify(timing)],
      );
      computed += 1;
    } catch (e) {
      console.error(`[housing] timing persist ${key} failed:`, e.message);
    }
  }
  return computed;
}

// Read the stored timing for a region key. null when we have no data.
async function getTimingByKey(regionKey) {
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      'SELECT region_name, timing FROM housing_timing WHERE region_key = $1', [regionKey]);
    return rows[0] || null;
  } catch (e) {
    console.error('[housing] getTiming failed:', e.message);
    return null;
  }
}

// The region names we currently hold timing for (for school resolution).
async function listTimingRegionNames() {
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query('SELECT region_name FROM housing_timing');
    return rows.map(r => r.region_name);
  } catch {
    return [];
  }
}

module.exports = {
  SOURCE, DEFAULT_ZORI_URL,
  parseCsvLine, parseZoriCsv, computeSeasonality,
  normalizeRegionKey, resolveSchoolToMetro, CURATED_SCHOOL_METRO,
  ingestZori, computeAndStoreTiming, getTimingByKey, listTimingRegionNames,
};
