// ─── Backfill listing coordinates ─────────────────────────────────────────
//
// Listings created before the geocoding change have latitude/longitude NULL,
// so distanceMi is null for all of them and the app's "Closest" sort never
// appears. New listings geocode themselves on insert; this fills in history.
//
//   node scripts/backfill-listing-geocode.js                 # backfill everything
//   node scripts/backfill-listing-geocode.js --limit 20      # a first careful batch
//   node scripts/backfill-listing-geocode.js --dry-run       # look, don't write
//   node scripts/backfill-listing-geocode.js --retry-misses  # re-attempt known failures
//
// SAFE TO RUN REPEATEDLY. It only ever selects rows with geocoded_at IS NULL,
// and stamps geocoded_at whether or not coordinates were found — so a second
// run picks up only what the first didn't reach. Addresses that genuinely
// can't be resolved are stamped-with-NULL and skipped forever after, which is
// what --retry-misses is for when an address gets corrected.
//
// It writes ONLY latitude, longitude and geocoded_at. Nothing else is touched.
//
// Pace: the geocoder self-throttles to ~1 request/second out of respect for
// Nominatim, which is free and unmetered. A hundred listings takes a bit under
// two minutes. Don't parallelise it — that's how a free dependency becomes a
// blocked one.

const pool = require('../src/db/pool');
const { geocodeListing } = require('../src/services/geocode');

/**
 * The loop, separated from process/CLI concerns so it can be tested with a
 * stub pool and stub geocoder. Everything that can actually be WRONG here —
 * which rows get picked, what gets written on a miss, whether a single bad
 * address halts the run — lives in this function.
 */
async function backfill({ db, geocode, limit = null, dryRun = false, retryMisses = false, log = console.log }) {
  const where = retryMisses
    // Rows we've tried and failed on: stamped, but still without coordinates.
    ? 'geocoded_at IS NOT NULL AND latitude IS NULL'
    : 'geocoded_at IS NULL';

  const { rows } = await db.query(
    `SELECT id, address, city, school_near
       FROM listings
      WHERE ${where}
        AND address IS NOT NULL AND btrim(address) <> ''
      ORDER BY created_at ASC
      ${limit ? `LIMIT ${Number(limit)}` : ''}`,
  );

  const stats = { total: rows.length, located: 0, missed: 0, failed: 0 };
  if (!rows.length) {
    log('Nothing to backfill.');
    return stats;
  }
  log(`${rows.length} listing(s) to geocode${dryRun ? ' (dry run)' : ''}.`);

  for (const [i, r] of rows.entries()) {
    const label = `[${i + 1}/${rows.length}] ${r.address}`;
    let coords = null;
    try {
      coords = await geocode({ address: r.address, city: r.city, schoolNear: r.school_near });
    } catch (err) {
      // geocodeListing already swallows everything, so reaching here means
      // something unexpected. One bad row must not abandon the rest of the run.
      stats.failed += 1;
      log(`${label} — ERROR ${err.message}`);
      continue;
    }

    if (coords) stats.located += 1; else stats.missed += 1;

    if (dryRun) {
      log(`${label} — ${coords ? `${coords.lat}, ${coords.lon}` : 'no match'} (not written)`);
      continue;
    }

    try {
      await db.query(
        `UPDATE listings
            SET latitude = $2, longitude = $3, geocoded_at = now()
          WHERE id = $1`,
        [r.id, coords?.lat ?? null, coords?.lon ?? null],
      );
      log(`${label} — ${coords ? `${coords.lat}, ${coords.lon}` : 'no match (stamped, will not retry)'}`);
    } catch (err) {
      stats.failed += 1;
      log(`${label} — WRITE FAILED ${err.message}`);
    }
  }

  log(`\nDone. located ${stats.located} · no match ${stats.missed} · failed ${stats.failed}`);
  return stats;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };

  const limit = value('limit');
  if (limit !== null && !/^\d+$/.test(limit)) {
    console.error('--limit needs a whole number');
    process.exit(1);
  }

  const stats = await backfill({
    db: pool,
    geocode: geocodeListing,
    limit,
    dryRun: flag('dry-run'),
    retryMisses: flag('retry-misses'),
  });

  await pool.end().catch(() => {});
  // A non-zero exit on write failures so this is safe to run from CI or a
  // one-off job and have the failure actually surface.
  process.exit(stats.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('backfill failed:', err);
    process.exit(1);
  });
}

module.exports = { backfill };
