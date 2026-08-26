/**
 * Re-read listings we already hold, and retire the ones the source has dropped.
 *
 * The collector only ever added. filterNew skips anything already stored so a
 * cycle does not re-download an entire sitemap, which is right — but it meant
 * nothing ever looked at a listing again once it was in. Craigslist housing
 * expires in about 30 days and a rental comes down the moment it is let, often
 * within days, so the app would have drifted into advertising places that no
 * longer exist. Quietly, under a "no fake listings" promise: from the student's
 * side, a flat that was rented last week is not distinguishable from a fake.
 *
 * WHAT COUNTS AS GONE
 *
 * Only 404 and 410 — the source saying, unambiguously, that this posting is no
 * longer there. Everything else leaves the listing alone:
 *
 *   403 blocked   is about US, not the listing. Retiring a student's options
 *                 because a site started refusing our user agent would turn
 *                 our problem into their empty screen.
 *   5xx / timeout is weather. It says nothing about whether the flat exists.
 *
 * A listing is never deleted, only deactivated — the same reasoning as a
 * rejected listing keeping its row. What was withdrawn, and when, is worth
 * being able to ask later.
 */

const pool = require('../db/pool');

/**
 * One sweep: re-read the least-recently-checked listings.
 *
 * Ordered by last_checked_at NULLS FIRST, so the oldest information is always
 * the next thing re-read and a listing can never be starved by newer arrivals.
 */
async function recheckListings({ politeFetch, limit = 100, log = console.log, db = pool }) {
  const stats = { checked: 0, live: 0, gone: 0, blocked: 0, failed: 0 };

  const { rows } = await db.query(
    `SELECT id, source, source_url, address
       FROM listings
      WHERE source_url IS NOT NULL
        AND is_active = TRUE
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
  );

  if (!rows.length) return stats;

  for (const r of rows) {
    stats.checked++;
    const res = await politeFetch(r.source_url);

    if (res.ok) {
      stats.live++;
      await db.query('UPDATE listings SET last_checked_at = now() WHERE id = $1', [r.id]);
      continue;
    }

    if (res.gone) {
      stats.gone++;
      // Deactivated, not deleted. is_active is the flag both student-facing
      // queries already filter on, so this takes effect immediately without
      // touching moderation_status — a human's decision stays a human's.
      await db.query(
        `UPDATE listings
            SET is_active = FALSE, unavailable_at = now(), last_checked_at = now()
          WHERE id = $1`,
        [r.id],
      );
      log(`GONE  ${String(r.source).padEnd(11)} ${String(r.address || '').slice(0, 44)}`);
      continue;
    }

    // Not stamped: a blocked or failed check has learned nothing, so the
    // listing stays at the front of the queue for the next sweep rather than
    // going to the back as though it had been verified.
    if (res.blocked) stats.blocked++;
    else stats.failed++;
  }

  return stats;
}

module.exports = { recheckListings };
