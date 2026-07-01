// Tests for the housing-timing pure logic (CSV parse, seasonal compute, region
// resolution). No DB / network — the ingest/store functions lazy-require pool.
// Run with `npm test` (node --test).
const test = require('node:test');
const assert = require('node:assert');
const {
  parseCsvLine, parseZoriCsv, computeSeasonality,
  normalizeRegionKey, resolveSchoolToMetro, SOURCE,
  normalizeSchoolName, domainCandidates, cbsaShort, normCounty, resolveHousing,
} = require('./housingTiming');

test('parseCsvLine handles quoted fields with embedded commas', () => {
  assert.deepEqual(
    parseCsvLine('1,0,"Riverside, CA",msa,CA,1800.50'),
    ['1', '0', 'Riverside, CA', 'msa', 'CA', '1800.50'],
  );
  assert.deepEqual(parseCsvLine('a,"b""c",d'), ['a', 'b"c', 'd']); // escaped quote
});

test('parseZoriCsv extracts per-region monthly series, skipping blanks', () => {
  const csv = [
    'RegionID,SizeRank,RegionName,RegionType,StateName,2024-01-31,2024-02-29',
    '1,0,"Riverside, CA",msa,CA,1800.50,1810.00',
    '2,1,"San Diego, CA",msa,CA,2500,',   // Feb blank → skipped
  ].join('\n');
  const out = parseZoriCsv(csv);
  assert.equal(out.length, 2);
  const riv = out.find(r => r.regionName === 'Riverside, CA');
  assert.equal(riv.state, 'CA');
  assert.deepEqual(riv.series, [
    { period: '2024-01-01', rent: 1800.5 },
    { period: '2024-02-01', rent: 1810 },
  ]);
  const sd = out.find(r => r.regionName === 'San Diego, CA');
  assert.equal(sd.series.length, 1); // the blank Feb cell was dropped
});

test('computeSeasonality finds the seasonal trough and a sane swing', () => {
  // 4 years, linear up-trend + a seasonal pattern with July peak / January trough.
  const seasonal = (m) => 1 + 0.05 * Math.cos((2 * Math.PI * (m - 6)) / 12); // m: 0=Jan..11=Dec
  const series = [];
  let i = 0;
  for (let y = 2022; y <= 2025; y++) {
    for (let mo = 1; mo <= 12; mo++, i++) {
      const trend = 2000 + 5 * i;
      series.push({ period: `${y}-${String(mo).padStart(2, '0')}-01`, rent: trend * seasonal(mo - 1) });
    }
  }
  const t = computeSeasonality(series);
  assert.ok(t, 'enough data → a result');
  assert.ok(t.bestMonthsToSearch.includes('January'), `cheapest month should be January, got ${t.bestMonthsToSearch}`);
  assert.ok(!t.bestMonthsToSearch.includes('July'), 'July is the peak, never a "best to search" month');
  const swing = Number(t.expectedSeasonalSwing.replace('%', ''));
  assert.ok(swing >= 8 && swing <= 12, `~10% swing expected, got ${t.expectedSeasonalSwing}`);
  assert.ok(t.leadTimeWeeks >= 4 && t.leadTimeWeeks <= 10);
  assert.equal(t.asOf, '2025-12');
  assert.equal(t.source, SOURCE);
});

test('computeSeasonality returns null on too-little data', () => {
  const thin = Array.from({ length: 12 }, (_, i) => ({ period: `2025-${String(i + 1).padStart(2, '0')}-01`, rent: 2000 }));
  assert.equal(computeSeasonality(thin), null);
});

test('normalizeRegionKey makes a stable "city-st" key', () => {
  assert.equal(normalizeRegionKey('Riverside, CA'), 'riverside-ca');
  assert.equal(normalizeRegionKey('New York, NY'), 'new-york-ny');
  assert.equal(normalizeRegionKey('  San Luis Obispo, CA '), 'san-luis-obispo-ca');
});

test('resolveSchoolToMetro: curated override, substring city, and honest null', () => {
  const have = ['Los Angeles, CA', 'San Diego, CA', 'Riverside, CA'];
  // Curated: Fullerton rolls up into LA.
  assert.equal(resolveSchoolToMetro('Cal State Fullerton', have), 'Los Angeles, CA');
  // Substring city match: "San Diego State University" contains "San Diego".
  assert.equal(resolveSchoolToMetro('San Diego State University', have), 'San Diego, CA');
  // No data / unknown → null (endpoint 404s; app degrades to reasoned guidance).
  assert.equal(resolveSchoolToMetro('University of Nowhere', have), null);
  assert.equal(resolveSchoolToMetro('San Diego State University', []), null); // no regions held
});

test('normalizeSchoolName mirrors the offline crosswalk key normalizer', () => {
  assert.equal(normalizeSchoolName('Ohio State University-Main Campus'), 'ohio state university main campus');
  assert.equal(normalizeSchoolName('Texas A&M'), 'texas a and m');
});

test('domainCandidates reduces a host to registrable-domain fallbacks', () => {
  assert.deepEqual(domainCandidates('jdoe@mail.law.osu.edu'), ['mail.law.osu.edu', 'law.osu.edu', 'osu.edu']);
  assert.deepEqual(domainCandidates('umich.edu'), ['umich.edu']);
  assert.deepEqual(domainCandidates(''), []);
});

test('cbsaShort reduces a full CBSA title to its ZORI "City, ST" key', () => {
  assert.equal(cbsaShort('New York-Newark-Jersey City, NY-NJ-PA'), 'New York, NY');
  assert.equal(cbsaShort('San Luis Obispo-Paso Robles, CA'), 'San Luis Obispo, CA');
  assert.equal(cbsaShort('Columbus, OH'), 'Columbus, OH');
});

test('normCounty strips the "County" suffix and normalizes', () => {
  assert.equal(normCounty('San Luis Obispo County'), 'san luis obispo');
  assert.equal(normCounty('St. Louis County'), 'st louis');
});

test('resolveHousing: the SLO→LA bug is fixed (area first, never a wrong metro)', () => {
  // THE bug: Cal Poly SLO with area "San Luis Obispo" must resolve to its own
  // CBSA, never Los Angeles (~200mi away). SLO is its own MSA that ZORI covers.
  const slo = resolveHousing({ school: 'Cal Poly SLO', domain: 'calpoly.edu', area: 'San Luis Obispo' });
  assert.equal(slo.cbsaFull, 'San Luis Obispo-Paso Robles, CA');
  assert.ok(!/Los Angeles/.test(slo.cbsaFull), 'must never be Los Angeles');
  // Domain alone (no area) still resolves SLO correctly.
  assert.equal(resolveHousing({ domain: 'calpoly.edu' }).cbsaFull, 'San Luis Obispo-Paso Robles, CA');
});

test('resolveHousing: correct metros for a spread of schools', () => {
  assert.equal(resolveHousing({ domain: 'osu.edu' }).cbsaFull, 'Columbus, OH');
  assert.equal(resolveHousing({ domain: 'nyu.edu' }).cbsaFull, 'New York-Newark-Jersey City, NY-NJ-PA');
  assert.equal(resolveHousing({ domain: 'umich.edu' }).cbsaFull, 'Ann Arbor, MI');
  // CSU Long Beach IS in the LA metro (Long Beach is a member) — correct, in-state.
  assert.equal(resolveHousing({ domain: 'csulb.edu' }).cbsaFull, 'Los Angeles-Long Beach-Anaheim, CA');
  // Sub-domained student email still resolves via the registrable domain.
  assert.equal(resolveHousing({ domain: 'mail.student.osu.edu' }).cbsaFull, 'Columbus, OH');
});

test('resolveHousing: unresolved / cross-state → null (404, never a default)', () => {
  // Unknown school → null; there is no blanket-default metro.
  assert.equal(resolveHousing({ school: 'Nowhere Institute of Nothing', domain: 'notareal.example' }), null);
  // Area with no known school → cannot gate on state → null.
  assert.equal(resolveHousing({ area: 'San Luis Obispo' }), null);
  // Explicit metro override is trusted; unknown metro string → null.
  assert.equal(resolveHousing({ metro: 'San Luis Obispo, CA' }).cbsaFull, 'San Luis Obispo-Paso Robles, CA');
  assert.equal(resolveHousing({ metro: 'Atlantis, ZZ' }), null);
});
