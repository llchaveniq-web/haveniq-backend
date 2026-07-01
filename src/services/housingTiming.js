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
// City-level ZORI — same public dataset at city granularity. Used to serve
// city-level timing (areaLevel:'city') when we hold it; the metro roll-up is the
// fallback. Override via env if Zillow moves the path.
const DEFAULT_ZORI_CITY_URL =
  'https://files.zillowstatic.com/research/public_csvs/zori/City_zori_uc_sfrcondomfr_sm_month.csv';
// HUD Fair Market Rents — annual, authoritative, EVERY US county. Served from
// HUD's own keyless ArcGIS FeatureServer (huduser.gov itself is WAF-gated). This
// is a LEVEL, not a seasonal index: county-level results carry typicalRent and
// hasSeasonal:false, and are NEVER labeled Zillow/seasonal. FMR area codes
// encode the geography: NCNTY{fips}N{fips} = a nonmetro county (FIPS direct);
// METRO{cbsa}M{cbsa} = a metro (covers many counties → mapped via countyCbsa).
const HUD_FMR_QUERY_URL =
  'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Fair_Market_Rents/FeatureServer/0/query';

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
  const typicalRent = Math.round(v[n - 1]);        // latest observed monthly rent ($)

  return {
    bestMonthsToSearch,
    expectedSeasonalSwing: `${swingPct}%`,
    leadTimeWeeks,
    typicalRent,
    hasSeasonal: true,        // ZORI IS a seasonal index — months are real
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

// ── National school→CBSA crosswalk (authoritative membership, no guessing) ────
// Prebuilt bundle (src/data/housingCrosswalk.json), built offline from PUBLIC
// data: IPEDS HD (every US institution → city/state/ZIP/county, keyed by .edu
// domain and normalized name) × Zillow ZORI's Census-CBSA geography (ZIP / city /
// county → CBSA). A school maps to a metro ONLY when its own ZIP/city/county —
// or the student-typed area, within the school's state — is a MEMBER of that
// CBSA. There is deliberately NO nearest-metro / distance fallback: snapping a
// campus to the closest big city is exactly the SLO→Los Angeles bug this
// replaces. Unresolved, or a cross-state resolution, returns null → the route
// 404s and the app degrades to honest reasoned guidance.
let _bundle = null;
function loadBundle() {
  if (_bundle) return _bundle;
  try { _bundle = require('../data/housingCrosswalk.json'); }
  catch { _bundle = { byDomain: {}, byName: {}, byZip: {}, byCityState: {}, byCountyState: {}, cbsa: {} }; }
  return _bundle;
}

// Mirror the offline name normalizer exactly (lowercase, & → and, strip
// punctuation to spaces, collapse) so app-supplied names hit the byName /
// byCityState keys.
function normalizeSchoolName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Reduce a host to candidate registrable domains, most specific first, so a
// student email like "jdoe@mail.law.osu.edu" still falls back to "osu.edu".
function domainCandidates(domain) {
  const host = String(domain || '').toLowerCase().trim().replace(/^.*@/, '');
  if (!host) return [];
  const labels = host.split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out; // [full, …, registrable]
}

// Reduce a ZORI CBSA full title to its short "City, ST" key (how the metro rent
// series is keyed): "New York-Newark-Jersey City, NY-NJ-PA" → "New York, NY".
function cbsaShort(full) {
  const s = String(full || '');
  const c = s.lastIndexOf(',');
  if (c < 0) return s.trim();
  return `${s.slice(0, c).split('-')[0].trim()}, ${s.slice(c + 1).trim().split('-')[0].trim()}`;
}

// County key: "San Luis Obispo County" → "san luis obispo" (IPEDS and ZORI both
// spell counties "X County"), normalized like the city keys.
function normCounty(s) {
  return normalizeSchoolName(String(s || '').replace(/\s+county$/i, ''));
}

/**
 * Resolve a request to what we can serve, honestly. Returns
 *   { zori: { short, cbsaFull, city } | null, fips: string | null }
 * or null when we can't even identify the school (→ 404). `zori` is the
 * seasonal ZORI resolution (city = canonical "City, ST" when a city-level
 * series exists); `fips` is the school's county FIPS for the HUD county-level
 * fallback. The route applies precedence: ZORI city → ZORI metro → HUD county.
 *
 * ZORI resolution priority (per the brief):
 *   1. metro — explicit override, trusted.
 *   2. area  — student-typed locality (strongest signal), gated to school state.
 *   3. domain / name → school ZIP → school city → school county.
 * Sanity gate: the resolved CBSA's state must include the school's state.
 * Membership holds by construction — only the school's OWN zip/city/county, or
 * the typed area within its state — never the nearest metro by distance.
 */
function resolveHousing({ metro, area, domain, school } = {}) {
  const b = loadBundle();

  // school → location (state gate, ZIP/city/county fallbacks, and the county
  // FIPS for the HUD county-level fallback).
  let loc = null;
  for (const d of domainCandidates(domain)) { if (b.byDomain[d]) { loc = b.byDomain[d]; break; } }
  if (!loc && school) { const n = normalizeSchoolName(school); if (b.byName[n]) loc = b.byName[n]; }
  const schoolState = loc ? loc.state : null;
  const fips = loc && loc.fips ? loc.fips : null;

  // 1. explicit metro override — trust it (short name or full CBSA title).
  if (metro && String(metro).trim()) {
    const m = String(metro).trim();
    let short = b.cbsa[m] ? m : null;
    if (!short) for (const s of Object.keys(b.cbsa)) { if (b.cbsa[s].full === m) { short = s; break; } }
    return short ? { zori: { short, cbsaFull: b.cbsa[short].full, city: null }, fips: null } : null;
  }

  let short = null, cityEntry = null;

  // 2. typed area first — strongest locality signal; gated to the school's state.
  if (area && schoolState) {
    const e = b.byCityState[`${normalizeSchoolName(area)}|${schoolState}`];
    if (e) { short = e.short; cityEntry = e; }
  }

  // 3/4/5. school ZIP → school city → school county (all authoritative members).
  if (!short && loc) {
    const zip = String(loc.zip || '').padStart(5, '0');
    if (b.byZip[zip]) short = b.byZip[zip];
    const ce = b.byCityState[`${normalizeSchoolName(loc.city)}|${schoolState}`];
    if (!short && ce) short = ce.short;
    if (short && ce && ce.short === short) cityEntry = ce;
    if (!short && loc.county) short = b.byCountyState[`${normCounty(loc.county)}|${schoolState}`] || null;
  }

  // ZORI (seasonal) resolution, with the state sanity gate applied.
  let zori = null;
  if (short) {
    const info = b.cbsa[short];
    if (info && (!schoolState || info.states.includes(schoolState))) {
      const city = (cityEntry && cityEntry.short === short && cityEntry.cityData) ? cityEntry.city : null;
      zori = { short, cbsaFull: info.full, city };
    }
  }

  // Nothing to serve if we couldn't even identify the school (no ZORI, no FIPS).
  if (!zori && !fips) return null;
  return { zori, fips };
}

// Load the bundled county-FIPS → CBSA-code map (Census delineation), used by the
// HUD ingest to attach metro-county FMRs (nonmetro counties key directly).
let _countyCbsa = null;
function loadCountyCbsa() {
  if (_countyCbsa) return _countyCbsa;
  try { _countyCbsa = require('../data/countyCbsa.json'); }
  catch { _countyCbsa = {}; }
  return _countyCbsa;
}

// ── Fuzzy school match + review queue (crosswalk maintenance) ─────────────────
// The offline crosswalk is keyed by exact .edu domain + normalized name. For a
// NEW / renamed / misspelled school that doesn't hit those, this token-Jaccard
// match against the IPEDS name index proposes a candidate with a confidence.
// The rule (never auto-ship a guess): HIGH → usable, MID → held for review,
// LOW → no match. The scheduled maintenance path records MID matches to the
// review queue instead of shipping them live.
const FUZZY_HIGH = 0.85, FUZZY_MIN = 0.55;
function fuzzyMatchSchool(name) {
  const b = loadBundle();
  const q = new Set(normalizeSchoolName(name).split(' ').filter(Boolean));
  if (!q.size) return { match: null, confidence: 0, loc: null, verdict: 'none' };
  let best = null, bestScore = 0;
  for (const key of Object.keys(b.byName)) {
    const t = key.split(' ');
    let inter = 0; for (const w of t) if (q.has(w)) inter++;
    const jac = inter / (q.size + t.length - inter);
    if (jac > bestScore) { bestScore = jac; best = key; }
  }
  const confidence = Number(bestScore.toFixed(3));
  const verdict = confidence >= FUZZY_HIGH ? 'high' : confidence >= FUZZY_MIN ? 'review' : 'none';
  return { match: best, confidence, loc: verdict === 'none' ? null : b.byName[best], verdict };
}

// Persist a held-for-review match (best-effort; table created by migrate_missing).
async function recordCrosswalkReview({ school, domain, proposed, confidence, reason }) {
  try {
    const pool = require('../db/pool');
    await pool.query(
      `INSERT INTO housing_crosswalk_review (school_name, domain, proposed_region, confidence, reason)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [school || null, domain || null, proposed || null, confidence ?? null, reason || 'low_confidence'],
    );
    return true;
  } catch (e) { console.error('[housing] review insert failed:', e.message); return false; }
}

async function listCrosswalkReview(status = 'pending') {
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      `SELECT id, school_name, domain, proposed_region, confidence, reason, status, created_at
         FROM housing_crosswalk_review WHERE status = $1 ORDER BY created_at DESC LIMIT 500`, [status]);
    return rows;
  } catch { return []; }
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
  // City-level timing is a best-effort enrichment — a failure here just means
  // the app serves the (correct) metro roll-up instead of a city-level number.
  const cities = await ingestCityTiming().catch(e => ({ ok: false, reason: e.message }));
  // HUD county-level FMR (annual levels) — closes the ZORI coverage gap toward
  // ~100%. Best-effort: a failure just leaves the (correct) 404 for uncovered
  // rural areas instead of a county-level level.
  const counties = await ingestCountyFmr().catch(e => ({ ok: false, reason: e.message }));
  return { ok: true, regions: regions.length, rowsUpserted: upserted, computed, cities, counties };
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

// Compute + store CITY-level timing directly into housing_timing (keyed
// 'city:<key>' so it never collides with a same-named metro short key). Bounded
// to cities the crosswalk can actually resolve to, so we don't persist thousands
// of cities no school maps to. Timing is computed inline from the in-memory
// series — this deliberately does NOT touch housing_rent_index. Best-effort.
async function ingestCityTiming(url) {
  const pool = require('../db/pool');
  const csvUrl = url || process.env.ZORI_CITY_CSV_URL || DEFAULT_ZORI_CITY_URL;
  let regions;
  try {
    const res = await fetch(csvUrl, { headers: { 'user-agent': 'haveniq-housing-ingest/1' } });
    if (!res.ok) return { ok: false, reason: `download ${res.status}`, url: csvUrl };
    regions = parseZoriCsv(await res.text());
  } catch (e) {
    return { ok: false, reason: `download failed: ${e.message}`, url: csvUrl };
  }
  // Only the cities the crosswalk can resolve to (byCityState with cityData).
  const b = loadBundle();
  const allowed = new Set();
  for (const v of Object.values(b.byCityState || {})) {
    if (v && v.cityData && v.city) allowed.add(`city:${normalizeRegionKey(v.city)}`);
  }
  let stored = 0;
  for (const reg of regions) {
    if (!reg.state || !reg.regionName) continue;
    const canonical = `${reg.regionName}, ${reg.state}`;
    const key = `city:${normalizeRegionKey(canonical)}`;
    if (!allowed.has(key)) continue;
    const timing = computeSeasonality(reg.series);
    if (!timing) continue;
    try {
      await pool.query(
        `INSERT INTO housing_timing (region_key, region_name, region_type, state, timing, computed_at)
         VALUES ($1,$2,'city',$3,$4,NOW())
         ON CONFLICT (region_key) DO UPDATE
           SET region_name = EXCLUDED.region_name, region_type = 'city',
               state = EXCLUDED.state, timing = EXCLUDED.timing, computed_at = NOW()`,
        [key, canonical, reg.state, JSON.stringify(timing)],
      );
      stored += 1;
    } catch (e) {
      console.error(`[housing] city timing ${key} failed:`, e.message);
    }
  }
  return { ok: true, cities: regions.length, stored };
}

// Ingest HUD Fair Market Rents (county-level LEVELS) into housing_timing, keyed
// 'county:<FIPS>'. Source is HUD's keyless ArcGIS FeatureServer. Nonmetro FMR
// areas (NCNTY) carry the county FIPS directly; metro FMR areas (METRO{cbsa})
// are attached to their member counties via the bundled Census county→CBSA map.
// Stored as a LEVEL — typicalRent, hasSeasonal:false, bestMonthsToSearch:[] —
// with an honest HUD source label. NEVER seasonal, never a fabricated month.
async function ingestCountyFmr({ url } = {}) {
  const pool = require('../db/pool');
  const base = url || process.env.HUD_FMR_QUERY_URL || HUD_FMR_QUERY_URL;
  let features = [], year = null;
  try {
    // Fiscal year: HUD publishes next-FY FMRs in ~Aug–Sep; derive from the
    // layer's lastEditDate so the source label stays accurate year to year.
    const meta = await fetch(`${base.replace(/\/query$/, '')}?f=json`).then(r => r.json()).catch(() => null);
    const le = meta && meta.editingInfo && meta.editingInfo.lastEditDate;
    if (le) { const d = new Date(le); year = d.getUTCMonth() >= 7 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(); }
    for (let offset = 0; ; offset += 1000) {
      const qs = new URLSearchParams({
        where: '1=1', outFields: 'FMR_CODE,FMR_AREANAME,FMR_2BDR', returnGeometry: 'false',
        f: 'json', resultOffset: String(offset), resultRecordCount: '1000', orderByFields: 'OBJECTID',
      });
      const page = await fetch(`${base}?${qs}`).then(r => r.json());
      const batch = (page && page.features) || [];
      features.push(...batch);
      if (batch.length < 1000) break;
    }
  } catch (e) {
    return { ok: false, reason: `HUD fetch failed: ${e.message}` };
  }
  if (!features.length) return { ok: false, reason: 'no FMR areas' };

  const label = process.env.HUD_FMR_LABEL || `HUD Fair Market Rents (FY${year || new Date().getUTCFullYear()})`;
  const asOf = String(year || new Date().getUTCFullYear());

  // Decode FMR codes: nonmetro county FIPS → rent, metro CBSA → rent.
  const countyRent = {}, cbsaRent = {};
  for (const f of features) {
    const a = f.attributes || {};
    const code = a.FMR_CODE || '', rent = a.FMR_2BDR;
    if (!rent) continue;
    if (code.startsWith('NCNTY')) countyRent[code.slice(5, 10)] = { rent, area: a.FMR_AREANAME };
    else if (code.startsWith('METRO')) cbsaRent[code.slice(5, 10)] = { rent, area: a.FMR_AREANAME };
  }
  // Metro counties inherit their CBSA's FMR (every county in a CBSA shares it).
  const countyCbsa = loadCountyCbsa();
  for (const [fips, cbsa] of Object.entries(countyCbsa)) {
    if (!countyRent[fips] && cbsaRent[cbsa]) countyRent[fips] = cbsaRent[cbsa];
  }

  let stored = 0;
  for (const [fips, rec] of Object.entries(countyRent)) {
    const st = (rec.area && (rec.area.match(/,\s*([A-Z]{2})\b/) || [])[1]) || fips.slice(0, 2);
    const timing = {
      typicalRent: rec.rent,
      bestMonthsToSearch: [],   // HUD is an annual LEVEL — never invent months
      hasSeasonal: false,
      asOf,
      source: label,
    };
    try {
      await pool.query(
        `INSERT INTO housing_timing (region_key, region_name, region_type, state, timing, computed_at)
         VALUES ($1,$2,'county',$3,$4,NOW())
         ON CONFLICT (region_key) DO UPDATE
           SET region_name = EXCLUDED.region_name, region_type = 'county',
               state = EXCLUDED.state, timing = EXCLUDED.timing, computed_at = NOW()`,
        [`county:${fips}`, rec.area || `County ${fips}`, st, JSON.stringify(timing)],
      );
      stored += 1;
    } catch (e) {
      console.error(`[housing] county FMR ${fips} failed:`, e.message);
    }
  }
  return { ok: true, fmrAreas: features.length, counties: stored, label };
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
  SOURCE, DEFAULT_ZORI_URL, DEFAULT_ZORI_CITY_URL, HUD_FMR_QUERY_URL,
  parseCsvLine, parseZoriCsv, computeSeasonality,
  normalizeRegionKey, resolveSchoolToMetro, CURATED_SCHOOL_METRO,
  normalizeSchoolName, domainCandidates, cbsaShort, normCounty, resolveHousing, loadCountyCbsa,
  fuzzyMatchSchool, recordCrosswalkReview, listCrosswalkReview,
  ingestZori, ingestCityTiming, ingestCountyFmr, computeAndStoreTiming, getTimingByKey, listTimingRegionNames,
};
