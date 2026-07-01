// Tests for the housing data-refresh diff report. Pure compute + diff have no
// DB; the orchestrator uses a stateful fake pool. node --test.
const test = require('node:test');
const assert = require('node:assert');
const cd = require('./coverageDiff');

const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ── coverageForResolution: route precedence + honest 404 ────────────────────
test('coverageForResolution: city > metro > county > 404 precedence', () => {
  const map = new Map([
    ['city:san-diego-ca', { typicalRent: 2000 }],
    ['austin', { typicalRent: 1500 }],
    ['county:06001', { typicalRent: 1200 }],
  ]);
  // city hit
  assert.deepEqual(cd.coverageForResolution({ zori: { city: 'San Diego, CA', short: 'san-diego' }, fips: null }, map, normKey), { level: 'city', rent: 2000 });
  // city miss → metro
  assert.deepEqual(cd.coverageForResolution({ zori: { city: 'Nowhere, TX', short: 'austin' }, fips: null }, map, normKey), { level: 'metro', rent: 1500 });
  // no zori → county
  assert.deepEqual(cd.coverageForResolution({ zori: null, fips: '06001' }, map, normKey), { level: 'county', rent: 1200 });
  // nothing resolves → honest 404, no backfill
  assert.deepEqual(cd.coverageForResolution(null, map, normKey), { level: '404', rent: null });
  assert.deepEqual(cd.coverageForResolution({ zori: { city: 'X, YZ', short: 'nope' }, fips: '99999' }, map, normKey), { level: '404', rent: null });
});

// ── computeCoverage: totals over a fake school universe ──────────────────────
function fakeResolver(resolutions) {
  return {
    normalizeRegionKey: normKey,
    loadBundle: () => ({ byDomain: Object.fromEntries(Object.keys(resolutions).map((d) => [d, {}])) }),
    resolveHousing: ({ domain }) => resolutions[domain],
  };
}

test('computeCoverage: counts each level, notResolved for 404', () => {
  const map = new Map([['city:san-diego-ca', { typicalRent: 2000 }], ['austin', { typicalRent: 1500 }], ['county:06001', { typicalRent: 1200 }]]);
  const resolver = fakeResolver({
    'a.edu': { zori: { city: 'San Diego, CA', short: 'san-diego' }, fips: null },
    'b.edu': { zori: { city: 'Nowhere, TX', short: 'austin' }, fips: null },
    'c.edu': { zori: null, fips: '06001' },
    'd.edu': null,
  });
  const { totals, schools } = cd.computeCoverage(map, resolver);
  assert.deepEqual(totals, { city: 1, metro: 1, county: 1, notResolved: 1, total: 4 });
  assert.equal(schools['a.edu'].l, 'city');
  assert.equal(schools['d.edu'].l, '404');
  assert.equal(schools['a.edu'].r, 2000);
});

// ── diffSnapshots ────────────────────────────────────────────────────────────
test('diffSnapshots: newlyResolves, newly404s, regressions, rent moves + anomalies', () => {
  const prev = {
    'a.edu': { l: 'city', r: 2000 },   // → 404 (regression to 404, high)
    'b.edu': { l: '404', r: null },    // → metro (newly resolves)
    'c.edu': { l: 'metro', r: 1000 },  // rent → 1120 (+12% material move)
    'd.edu': { l: 'city', r: 3000 },   // rent → 4500 (+50% implausible jump)
    'e.edu': { l: 'metro', r: 900 },   // → county (downgrade regression, medium)
  };
  const curr = {
    'a.edu': { l: '404', r: null },
    'b.edu': { l: 'metro', r: 1400 },
    'c.edu': { l: 'metro', r: 1120 },
    'd.edu': { l: 'city', r: 4500 },
    'e.edu': { l: 'county', r: 850 },
  };
  const rep = cd.diffSnapshots(prev, curr, { rentMove: 0.10, rentAnomaly: 0.40 });
  assert.deepEqual(rep.newlyResolves.map((x) => x.domain), ['b.edu']);
  assert.deepEqual(rep.newly404s.map((x) => x.domain), ['a.edu']);
  assert.deepEqual(rep.regressions.map((x) => x.domain).sort(), ['a.edu', 'e.edu']);
  // material moves: c.edu (+12%) and d.edu (+50%), biggest first
  assert.equal(rep.rentMoves[0].domain, 'd.edu');
  assert.ok(rep.rentMoves.some((m) => m.domain === 'c.edu'));
  // anomalies: 2 regressions + 1 implausible jump (d.edu)
  const kinds = rep.anomalies.map((a) => `${a.kind}:${a.domain}`);
  assert.ok(kinds.includes('regression:a.edu'));
  assert.ok(kinds.includes('regression:e.edu'));
  assert.ok(kinds.includes('rent_jump:d.edu'));
  assert.equal(rep.anomalies.find((a) => a.domain === 'a.edu').severity, 'high'); // → 404
});

test('diffSnapshots: only compares schools present in BOTH snapshots', () => {
  const rep = cd.diffSnapshots({ 'a.edu': { l: 'city', r: 100 } }, { 'b.edu': { l: '404', r: null } });
  assert.equal(rep.regressions.length, 0);
  assert.equal(rep.newly404s.length, 0);
});

test('boardCoverageDrop: fires only on a large resolved-count fall', () => {
  assert.equal(cd.boardCoverageDrop({ total: 100, notResolved: 10 }, { total: 100, notResolved: 11 }, 0.05), null); // -1 of 90 = tiny
  const drop = cd.boardCoverageDrop({ total: 100, notResolved: 10 }, { total: 100, notResolved: 40 }, 0.05);
  assert.ok(drop && drop.kind === 'board_coverage_drop');
  assert.equal(drop.severity, 'high');
});

// ── Orchestrator: baseline → diff → alert ───────────────────────────────────
function statefulPool() {
  const snaps = [];
  return {
    snaps,
    query: async (sql, params = []) => {
      if (sql.includes('CREATE TABLE') || sql.includes('DELETE FROM coverage_snapshots')) return { rows: [] };
      if (sql.startsWith('SELECT * FROM coverage_snapshots')) return { rows: snaps.length ? [snaps[snaps.length - 1]] : [] };
      if (sql.includes('INSERT INTO coverage_snapshots')) {
        snaps.push({ totals: JSON.parse(params[0]), schools: JSON.parse(params[1]), diff: params[2] ? JSON.parse(params[2]) : null, anomaly_count: params[3], baseline: params[4], created_at: `t${snaps.length}` });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}
const TMAP = new Map([['city:san-diego-ca', { typicalRent: 2000 }], ['austin', { typicalRent: 1500 }]]);

test('runCoverageDiff: no timing data → ok:false (no fabricated report)', async () => {
  const pool = statefulPool();
  const r = await cd.runCoverageDiff({ pool, timingMap: new Map(), resolver: fakeResolver({ 'a.edu': null }), alert: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_timing_data');
  assert.equal(pool.snaps.length, 0);
});

test('runCoverageDiff: first run establishes a baseline, no alert', async () => {
  const pool = statefulPool();
  let alerts = 0;
  const resolver = fakeResolver({ 'a.edu': { zori: { city: 'San Diego, CA', short: 'san-diego' }, fips: null }, 'b.edu': { zori: { short: 'austin' }, fips: null } });
  const r = await cd.runCoverageDiff({ pool, timingMap: TMAP, resolver, alert: async () => { alerts++; } });
  assert.equal(r.baseline, true);
  assert.equal(alerts, 0);
  assert.equal(pool.snaps.length, 1);
  assert.equal(pool.snaps[0].baseline, true);
});

test('runCoverageDiff: a regression on the next refresh writes a diff + pages once', async () => {
  const pool = statefulPool();
  let alerts = 0;
  // A universe with enough stable schools that ONE regression isn't a board-wide
  // drop (1/21 ≈ 4.8% < 5% threshold) — so we isolate the single regression.
  const stable = {};
  for (let i = 0; i < 20; i++) stable[`m${i}.edu`] = { zori: { short: 'austin' }, fips: null };
  const baseline = { 'a.edu': { zori: { city: 'San Diego, CA', short: 'san-diego' }, fips: null }, ...stable };
  await cd.runCoverageDiff({ pool, timingMap: TMAP, resolver: fakeResolver(baseline), alert: async () => { alerts++; } });
  // refresh: a.edu now 404 (regression), the 20 metros unchanged
  const refreshed = { 'a.edu': null, ...stable };
  const r = await cd.runCoverageDiff({ pool, timingMap: TMAP, resolver: fakeResolver(refreshed), alert: async () => { alerts++; } });
  assert.equal(r.baseline, false);
  assert.equal(r.changed.regressions, 1);
  assert.equal(r.changed.newly404s, 1);
  assert.equal(r.changed.anomalies, 1);          // just the regression, no board drop
  assert.equal(alerts, 1);                       // paged on the regression transition
  assert.equal(pool.snaps.length, 2);
  assert.equal(pool.snaps[1].anomaly_count, 1);
});

test('runCoverageDiff: a routine no-change refresh does NOT page', async () => {
  const pool = statefulPool();
  let alerts = 0;
  const resolver = fakeResolver({ 'a.edu': { zori: { city: 'San Diego, CA', short: 'san-diego' }, fips: null } });
  await cd.runCoverageDiff({ pool, timingMap: TMAP, resolver, alert: async () => { alerts++; } });
  const r = await cd.runCoverageDiff({ pool, timingMap: TMAP, resolver, alert: async () => { alerts++; } });
  assert.equal(r.changed.anomalies, 0);
  assert.equal(alerts, 0);                       // silent routine refresh
});
