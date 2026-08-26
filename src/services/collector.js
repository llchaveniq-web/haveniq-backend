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
    if (!res.ok) return { ok: false, status: res.status, blocked: res.status === 403 };
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

  const perPersonCents = Math.round(parsed.totalRentCents / Math.max(1, parsed.beds));

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
 * Run one source over one region.
 *
 * `limit` caps postings per run. There is no "collect everything" mode on
 * purpose: 4,500 postings a day per region at one request per second is over
 * an hour of someone else's bandwidth, and a first run should be small enough
 * that a human can read every row it produced.
 */
async function collect(adapter, { region, schoolNear, city = null, limit = 25, dryRun = false, log = console.log }) {
  const stats = { seen: 0, parsed: 0, stored: 0, skipped: 0, blocked: 0, failed: 0 };

  const index = await politeFetch(adapter.SITEMAP_INDEX);
  if (!index.ok) {
    log(`sitemap index unavailable${index.blocked ? ' (blocked by robots.txt or refused)' : ''}: ${index.reason || index.status || index.error}`);
    stats.blocked = index.blocked ? 1 : 0;
    return stats;
  }

  const sitemaps = adapter.housingSitemapsFor(index.body, region);
  if (!sitemaps.length) { log(`no housing sitemap for region "${region}"`); return stats; }
  log(`${sitemaps.length} sitemap(s) for ${region}; reading the newest`);

  const sm = await politeFetch(sitemaps[0]);
  if (!sm.ok) { log(`sitemap unavailable: ${sm.reason || sm.status || sm.error}`); stats.failed++; return stats; }

  const urls = adapter.locs(sm.body).slice(0, limit);
  log(`${adapter.locs(sm.body).length} postings available, taking ${urls.length}${dryRun ? ' (dry run)' : ''}\n`);

  for (const url of urls) {
    stats.seen++;
    const res = await politeFetch(url);
    if (!res.ok) {
      if (res.blocked) { stats.blocked++; log(`BLOCKED ${url.slice(0, 64)} — ${res.reason || res.status}`); }
      else { stats.failed++; }
      continue;
    }

    const parsed = adapter.parsePosting(res.body, url);
    if (!parsed) { stats.skipped++; continue; }
    stats.parsed++;

    if (dryRun) {
      log(`WOULD STORE  $${parsed.totalRentCents / 100}  ${parsed.beds}br  ${(parsed.address || '(derive from coords)').slice(0, 34).padEnd(35)} ${parsed.title.slice(0, 40)}`);
      continue;
    }

    try {
      const out = await storeListing(parsed, { source: adapter.NAME || 'craigslist', schoolNear, city });
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

  log(`\nseen ${stats.seen} · parsed ${stats.parsed} · stored ${stats.stored} · skipped ${stats.skipped} · blocked ${stats.blocked} · failed ${stats.failed}`);
  return stats;
}

module.exports = { collect, storeListing, politeFetch, UA };
