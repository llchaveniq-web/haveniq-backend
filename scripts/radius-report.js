// ─── How far out a campus has to look ────────────────────────────────────
//
//   node scripts/radius-report.js
//   node scripts/radius-report.js --json      (one line, for sampling over time)
//
// The browse radius is currently one number, 30 miles, for every campus. That
// is defensible as a sanity cap and wrong as a curation rule, because the three
// campuses have opposite shapes:
//
//   USC   has cheap stock on its doorstep — a tight radius works.
//   UCLA  is priced out at 2 miles and affordable at 5-10, so a tight radius
//         would show students only the places they cannot afford.
//   OCC   had nothing at all until its backlog was published.
//
// So rather than three numbers I picked by hand — a table that goes stale the
// moment a neighbourhood changes — this measures the thing the number is
// supposed to approximate: how far you must go to have a real choice, and
// whether going further actually gets you anything cheaper.
//
// Run it across a few collection cycles before trusting it. A percentile over
// 2 listings is noise; the same percentile over 700 is a fact.

const pool = require('../src/db/pool');

const R = 3958.7613;
const rad = (d) => (d * Math.PI) / 180;
const haversine = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

const median = (xs) => xs.length
  ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  : null;

/**
 * The smallest whole-mile radius holding at least `target` listings.
 *
 * This is the honest version of "how far out should we look": far enough to
 * have a choice, and no further. Floored at 2 because a radius under that is
 * an accident of one building, capped at 25 because past that it is a
 * different city and the number has stopped meaning anything.
 */
function radiusFor(distances, target = 100) {
  const sorted = distances.slice().sort((a, b) => a - b);
  if (sorted.length < target) return null;         // not enough to say
  return Math.min(25, Math.max(2, Math.ceil(sorted[target - 1])));
}

(async () => {
  const { rows: schools } = await pool.query(
    `SELECT school, latitude, longitude FROM school_coords
      WHERE latitude IS NOT NULL ORDER BY school`);
  const { rows: L } = await pool.query(
    `SELECT latitude, longitude, per_person_rent_cents pp FROM listings
      WHERE is_active AND moderation_status = 'approved' AND latitude IS NOT NULL`);

  const out = { at: new Date().toISOString(), approved: L.length, schools: {} };

  for (const s of schools) {
    const campus = { lat: Number(s.latitude), lon: Number(s.longitude) };
    const near = L
      .map(r => ({ mi: haversine(campus, { lat: +r.latitude, lon: +r.longitude }), pp: r.pp / 100 }))
      .filter(x => x.mi <= 60);

    const within = (n) => near.filter(x => x.mi <= n);
    out.schools[s.school] = {
      n5: within(5).length, n10: within(10).length, n15: within(15).length, n30: within(30).length,
      r100: radiusFor(near.map(x => x.mi), 100),
      // Does going further actually buy anything? If the median barely moves,
      // a wider radius is just more scrolling.
      med5: median(within(5).map(x => x.pp)),
      med15: median(within(15).map(x => x.pp)),
      med30: median(within(30).map(x => x.pp)),
    };
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out));
  } else {
    console.log(`${out.approved} approved listings · ${out.at.slice(0, 16).replace('T', ' ')}\n`);
    for (const [school, d] of Object.entries(out.schools)) {
      console.log(school);
      console.log(`   within  5mi ${String(d.n5).padStart(4)}  median ${d.med5 ? '$' + Math.round(d.med5) : '—'}`);
      console.log(`   within 15mi ${String(d.n15).padStart(4)}  median ${d.med15 ? '$' + Math.round(d.med15) : '—'}`);
      console.log(`   within 30mi ${String(d.n30).padStart(4)}  median ${d.med30 ? '$' + Math.round(d.med30) : '—'}`);
      console.log(`   radius holding 100 listings: ${d.r100 ? d.r100 + ' mi' : 'not enough listings yet'}\n`);
    }
  }
  await pool.end().catch(() => {});
})().catch(e => { console.error('report failed:', e.message); process.exit(1); });
