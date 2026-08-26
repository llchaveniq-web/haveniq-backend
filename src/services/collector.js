/**
 * Listing collector — the loop that turns a source into pending listings.
 *
 * Sits between the source adapters (which know how to read one site) and the
 * moderation queue (which decides what a student sees). Its whole job is to do
 * that safely and slowly:
 *
 *   robots gate  every URL passes isAllowed() before it is fetched, including
 *                the sitemaps. A source we cannot read the rules for is not
 *                crawled at all.
 *   rate limit   one request per second by default, and a site's own
 *                Crawl-delay wins when it declares one. Deliberately serial.
 *   dedupe       source_url is UNIQUE, so a re-run over yesterday's sitemap is
 *                a no-op rather than a queue full of duplicates.
 *   score        every listing goes through listingRisk before it is stored.
 *   pending      NOTHING published. Collected listings land as 'pending' and a
 *                human approves them. That is the point: the landing page
 *                promises no fake listings, and a collector that could publish
 *                on its own would be the fastest way to break that promise.
 *
 * The collector NEVER retries a refusal with different headers, a different
 * user agent, or from anywhere else. If a source starts saying no, it stops
 * and reports that it stopped.
 */

const pool = require('../db/pool');
const robots = require('./robots');
const { assessListing } = require('./listingRisk');
const { reverseGeocode } = require('./geocode');

const UA = 'HavenIQBot/1.0 (+https://haveniq.org/bot)';
const DEFAULT_DELAY_MS = 1100;
const FETCH_TIMEOUT_MS = 25000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Fetch a URL, but only if robots.txt allows it.
 *
 * Returns { ok, status, body, blocked }. `blocked` distinguishes "we were told
 * not to" from "the request failed" — they look the same to a caller and mean
 * very different things to a human reading the run report.
 */
async function politeFetch(url, { delayMs = DEFAULT_DELAY_MS } = {}) {
  const verdict = await robots.isAllowed(url);
  if (!verdict.allowed) return { ok: false, blocked: true, reason: verdict.reason };

  // A site's declared Crawl-delay outranks our default whenever it is slower.
  const wait = Math.max(delayMs, (verdict.crawlDelay || 0) * 1000);
  await sleep(wait);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 404/410 is an EXPIRED posting, not a fault. Sitemaps include listings
    // that have since been taken down, and Craigslist inventory churns fast
    // enough that a normal run meets plenty of them. Counting those as
    // failures made a perfectly healthy run exit non-zero and look broken.
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        blocked: res.status === 403,
        gone: res.status === 404 || res.status === 410,
      };
    }
    return { ok: true, status: res.status, body: await res.text() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Store one parsed listing as pending, or report why it wasn't.
 *
 * `schoolNear` is supplied by the caller rather than inferred. A region code
 * is not a campus, and guessing which school a Los Angeles posting is "near"
 * is exactly the kind of invented data the moderation queue exists to keep out.
 */
async function storeListing(parsed, { source, schoolNear, city, createdBy = null }) {
  // An address is required by the schema and by the student. Craigslist maps
  // one on roughly six postings in ten; the rest are derived from the
  // posting's own coordinates.
  let address = parsed.address;
  let derivedCity = city;
  if (!address) {
    const rev = await reverseGeocode(parsed.latitude, parsed.longitude);
    if (!rev) return { stored: false, reason: 'no address and reverse geocode failed' };
    address = rev.address;
    derivedCity = derivedCity || rev.city;
  }

  // Per-person rent is the number HavenIQ is built on, and there are two ways
  // a source states it. A whole-unit rental advertises the total, so it is
  // divided by the bed count. A room or share advertises what ONE person pays,
  // and dividing that again understates it by exactly the bed count — the bug
  // that put a real $650 room in a 3BR into the queue as $216.
  const perPersonCents = parsed.pricedPerPerson
    ? parsed.totalRentCents
    : Math.round(parsed.totalRentCents / Math.max(1, parsed.beds));

  const risk = assessListing({
    address,
    perPerson: perPersonCents / 100,
    photoUrl: parsed.photoUrl || null,
    contactEmail: null,          // Craigslist relays mail; no address is exposed
    contactPhone: null,
    notes: parsed.notes,
    title: parsed.title,
  });

  // Even a clean score does not publish. A collected listing has no verified
  // poster behind it, and no classifier can tell whether whoever wrote it
  // controls the unit.
  const status = risk.recommendation === 'reject' ? 'rejected' : 'pending';

  const { rows } = await pool.query(
    `INSERT INTO listings
       (address, city, school_near, beds, baths,
        total_rent_cents, per_person_rent_cents, notes,
        latitude, longitude, geocoded_at,
        source, source_url, source_posted_at,
        moderation_status, risk_score, risk_signals, created_by, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11,$12,$13,$14,$15,$16,$17, TRUE)
     ON CONFLICT (source_url) WHERE source_url IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      address, derivedCity || null, schoolNear,
      parsed.beds, parsed.baths,
      parsed.totalRentCents, perPersonCents,
      [parsed.title, parsed.notes].filter(Boolean).join('\n\n').slice(0, 4000),
      parsed.latitude, parsed.longitude,
      source, parsed.sourceUrl, parsed.postedAt || null,
      status, risk.score, JSON.stringify(risk.signals), createdBy,
    ],
  );

  if (!rows[0]) return { stored: false, reason: 'already collected' };
  return { stored: true, id: rows[0].id, status, riskScore: risk.score };
}

/**
 * Drop the postings we already hold, WITHOUT fetching them.
 *
 * This is the difference between a script someone runs and a job that runs
 * itself. The insert already de-duplicates on source_url — but only after the
 * page has been downloaded, so a scheduled collector would re-fetch all 4,600
 * of a region's postings every cycle to discover it had seen 4,595 of them.
 * One bulk query instead, and a repeat pass costs almost nothing: it fetches
 * only what actually appeared since last time.
 *
 * It is also the polite behaviour. Re-reading someone else's entire sitemap
 * every half hour is how a crawler stops being welcome.
 */
async function filterNew(urls, source) {
  if (!urls.length) return urls;
  const { rows } = await pool.query(
    `SELECT source_url AS url FROM listings
      WHERE source = $1 AND source_url = ANY($2::text[])
      UNION
     SELECT url FROM collector_seen
      WHERE source = $1 AND url = ANY($2::text[]) AND outcome <> 'failed'`,
    [source, urls],
  );
  const seen = new Set(rows.map(r => r.url));
  return urls.filter(u => !seen.has(u));
}

/**
 * Remember that we tried a URL, and how it went.
 *
 * listings.source_url only remembers what was STORED. An expired posting is
 * never stored, so without this the 410s sitting at the top of a sitemap get
 * re-requested every single cycle and a scheduled run never reaches the live
 * listings behind them. Four of the first five LA postings were already gone
 * when this was written, so that is not a corner case.
 *
 * 'failed' is written too but deliberately NOT treated as settled: a timeout or
 * a 5xx should be retried next cycle, where an expired posting never should.
 */
async function remember(source, url, outcome) {
  try {
    await pool.query(
      `INSERT INTO collector_seen (source, url, outcome) VALUES ($1, $2, $3)
       ON CONFLICT (source, url) DO UPDATE SET outcome = EXCLUDED.outcome, seen_at = now()`,
      [source, url, outcome],
    );
  } catch {
    // Bookkeeping must never fail a collection run. The cost of losing a row
    // here is one wasted re-fetch next cycle.
  }
}

/**
 * Run one source over one region.
 *
 * `limit` caps postings per run. There is no "collect everything" mode on
 * purpose: 4,500 postings a day per region at one request per second is over
 * an hour of someone else's bandwidth, and a first run should be small enough
 * that a human can read every row it produced.
 */
async function collect(adapter, { region, schoolNear, city = null, limit = 25, dryRun = false, log = console.log }) {
  const stats = { seen: 0, parsed: 0, stored: 0, skipped: 0, gone: 0, blocked: 0, failed: 0 };

  // Discovery belongs to the adapter: Craigslist needs two hops through a
  // 2,800-entry index, Uloop needs one flat urlset per campus, and the next
  // source will differ again. The adapter is handed THIS polite fetcher rather
  // than fetching for itself, so the robots gate and the rate limit stay in one
  // place instead of being re-implemented — and forgotten — per source.
  const found = await adapter.collectUrls(politeFetch, region);
  if (found.error || !found.urls.length) {
    log(found.error || `nothing published for "${region}"`);
    if (found.blocked) stats.blocked = 1;
    else if (found.error) stats.failed = 1;
    return stats;
  }

  const all = found.urls;
  // Drop what we already hold BEFORE spending a request on it. This is what
  // makes a scheduled run cheap instead of a full re-download every cycle.
  const fresh = dryRun ? all : await filterNew(all, adapter.NAME);
  const urls = fresh.slice(0, limit);
  log(`${all.length} available · ${all.length - fresh.length} already collected · taking ${urls.length}${dryRun ? ' (dry run)' : ''}\n`);
  if (!urls.length) { log('nothing new'); return stats; }

  for (const url of urls) {
    stats.seen++;
    const res = await politeFetch(url);
    if (!res.ok) {
      if (res.blocked) { stats.blocked++; log(`BLOCKED ${url.slice(0, 64)} — ${res.reason || res.status}`); }
      else if (res.gone) { stats.gone++; if (!dryRun) await remember(adapter.NAME, url, 'expired'); }
      else { stats.failed++; if (!dryRun) await remember(adapter.NAME, url, 'failed'); }
      continue;
    }

    const parsed = adapter.parsePosting(res.body, url);
    // A page we fetched and could not use (a parking space, no price) is
    // settled: re-reading it next cycle would reach the same conclusion.
    if (!parsed) { stats.skipped++; if (!dryRun) await remember(adapter.NAME, url, 'skipped'); continue; }
    stats.parsed++;

    if (dryRun) {
      log(`WOULD STORE  $${parsed.totalRentCents / 100}  ${parsed.beds}br  ${(parsed.address || '(derive from coords)').slice(0, 34).padEnd(35)} ${parsed.title.slice(0, 40)}`);
      continue;
    }

    try {
      const out = await storeListing(parsed, { source: adapter.NAME, schoolNear, city });
      if (!dryRun) await remember(adapter.NAME, url, 'stored');
      if (out.stored) {
        stats.stored++;
        log(`${out.status.toUpperCase().padEnd(9)} risk:${String(out.riskScore).padStart(3)}  $${parsed.totalRentCents / 100}  ${parsed.title.slice(0, 46)}`);
      } else {
        stats.skipped++;
      }
    } catch (e) {
      stats.failed++;
      log(`FAILED ${e.message.slice(0, 70)}`);
    }
  }

  log(`\nseen ${stats.seen} · parsed ${stats.parsed} · stored ${stats.stored} · skipped ${stats.skipped} · expired ${stats.gone} · blocked ${stats.blocked} · failed ${stats.failed}`);
  return stats;
}

module.exports = { collect, storeListing, politeFetch, filterNew, remember, UA };
