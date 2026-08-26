/**
 * Craigslist source adapter — sitemap discovery and posting extraction.
 *
 * WHY THIS SOURCE, AND HOW IT IS REACHED
 *
 * Craigslist publishes 2,800 sitemaps partitioned by region and category, of
 * which 463 are housing (`-hhh.xml`). A single day's Los Angeles housing
 * sitemap carries ~4,500 postings. That is the supply, and it is enumerable
 * exactly the way a site intends to be enumerated: by reading the sitemaps it
 * advertises in its own robots.txt.
 *
 * Verified with an identified `HavenIQBot` user agent, not a disguised one:
 *
 *     sitemap index      200
 *     regional sitemap   200   (596 KB, 4,502 postings)
 *     posting page       200   (28 KB, structured)
 *
 * The ONE endpoint that refuses an identified bot is the search/RSS interface
 * (`/search/apa?format=rss` returns 403 "Your request has been blocked"). We do
 * not use it, and we do not dress up as a browser to reach it. The sitemaps
 * carry the same postings and are served to us willingly.
 *
 * Everything below parses HTML the site returns to a bot that says who it is.
 * There is no fingerprint spoofing, no CAPTCHA handling, no retry-with-a-
 * different-hat. If Craigslist starts refusing HavenIQBot, this adapter stops
 * working and that is the correct outcome — a human then decides what to do,
 * rather than the code deciding to hide.
 *
 * A NOTE ON TERMS. robots.txt permits these paths; Craigslist's Terms of Use
 * separately prohibit scraping. Those instruments disagree, and HavenIQ has
 * taken that risk knowingly. Recorded here so nobody later mistakes the robots
 * check for legal clearance.
 */

const CATEGORY = 'hhh';                       // housing
const SITEMAP_INDEX = 'https://www.craigslist.org/sitemap-index-postings-00.xml';

/** Pull every <loc> out of a sitemap or sitemap index. */
function locs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
}

/**
 * Housing sitemaps for a region code ('lax', 'sfo', 'nyc'…), newest first.
 *
 * Filenames carry the date and the category — sitemap-postings-YYYY-MM-DD-
 * <region>-<cat>.xml — so the filter is a filename match rather than a fetch
 * of all 2,800 children.
 */
function housingSitemapsFor(indexXml, region) {
  const want = new RegExp(`-${region}-${CATEGORY}\\.xml$`, 'i');
  return locs(indexXml).filter(u => want.test(u)).sort().reverse();
}

const strip = (s) => String(s || '')
  .replace(/<[^>]*>/g, ' ')
  // Numeric entities too, not just the named ones. Craigslist writes its
  // direction marks as &#8206;, which without this survives as literal text in
  // the stored title — visible, ugly, and unsearchable.
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

const first = (html, re) => {
  const m = String(html).match(re);
  return m ? m[1] : null;
};

/** "$1,200" -> 120000 cents. Null when absent or unparseable. */
function priceCents(html) {
  const raw = first(html, /<span class="price">\s*\$?([\d,]+)/);
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/**
 * "0BR / 1Ba 569ft2 available now" -> { beds, baths }.
 *
 * 0BR is a studio, which HavenIQ stores as 1 bed: the listings table CHECKs
 * beds BETWEEN 1 AND 10, and a studio is a place one person lives, not a place
 * with no bedrooms. Losing that distinction is a smaller lie than dropping
 * every studio near a campus, which is most of the cheap supply.
 */
function bedsBaths(html) {
  const group = first(html, /<div class="attrgroup">([\s\S]*?)<\/div>/);
  const text = strip(group);
  const br = text.match(/(\d+)\s*BR/i);
  const ba = text.match(/([\d.]+)\s*Ba/i);
  const beds = br ? Math.max(1, Number(br[1])) : null;
  const baths = ba ? Number(ba[1]) : null;
  return {
    beds: Number.isFinite(beds) && beds >= 1 && beds <= 10 ? beds : null,
    baths: Number.isFinite(baths) && baths > 0 && baths <= 10 ? baths : null,
    isStudio: !!(br && Number(br[1]) === 0),
  };
}

/**
 * Craigslist titles arrive as "<the actual title> - <category> - craigslist".
 *
 * Stripped from the RIGHT, segment by segment, and only while the trailing
 * segment is recognisably boilerplate. A blunt "cut everything after the last
 * dash" would eat real titles — "2BR in Westwood - available Sept 1" is a
 * listing whose most useful half is after the dash.
 */
function cleanTitle(raw) {
  // Craigslist truncates its own og:title, so the trailing boilerplate segment
  // can arrive cut off ("apartment..."). Normalise that away before testing,
  // or the match fails on exactly the pages that need it most.
  const norm = (s) => s.trim().replace(/[.…]+$/, '').trim();
  const BOILER = /^(craigslist|apts?[/ ]?hous\w*.*|hous\w+.*|rooms?\b.*|sublets?\b.*|apartments?|for rent|real estate.*)$/i;

  const parts = String(raw)
    // Strip bidi/direction marks Craigslist prepends to some titles; they are
    // invisible but survive into the stored title and any search over it.
    .replace(/[‎‏‪-‮﻿]/g, '')
    .split(' - ');

  while (parts.length > 1 && BOILER.test(norm(parts[parts.length - 1]))) parts.pop();
  return parts.join(' - ').trim();
}

/** Coordinates come free on Craigslist — no geocoder call needed. */
function coords(html) {
  const rawLat = first(html, /data-latitude="([^"]+)"/);
  const rawLon = first(html, /data-longitude="([^"]+)"/);
  // Guard BEFORE Number(): Number(null) is 0, which is finite and inside the
  // valid range, so a posting with no coordinates would be stored at 0,0 —
  // null island in the Gulf of Guinea — and pass every check below it.
  if (rawLat == null || rawLon == null) return { lat: null, lon: null };
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat: null, lon: null };
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { lat: null, lon: null };
  return { lat, lon };
}

/**
 * The subcategory this posting sits in, from its breadcrumb.
 *
 * The `hhh` sitemap is ALL housing, which includes parking spaces, storage
 * units and property for sale. Sampling turned up a storage-unit advert on the
 * first pass. Only three subcategories are places a student can live:
 *
 *   apa  apartments / housing for rent
 *   roo  rooms & shares
 *   sub  sublets & temporary
 *
 * Anything else is filtered out rather than filed as a rental.
 */
const RENTAL_CATS = new Set(['apa', 'roo', 'sub']);

function subcategory(html) {
  const cats = [...String(html).matchAll(/[?&]cat=([a-z]{3})/g)].map(m => m[1]);
  return cats.length ? cats[cats.length - 1] : null;
}

/** Street address when the posting maps one. Roughly 6 in 10 do. */
function mapAddress(html) {
  const raw = first(html, /<div class="mapaddress">([\s\S]*?)<\/div>/);
  const addr = strip(raw);
  // "near 3rd street" on its own is a cross-street, not an address — useful
  // as context but not something to file as the location of a home.
  return addr && /\d/.test(addr) ? addr : null;
}

/** Every attr chip: rent period, pets, laundry, parking, aircon. */
function attributes(html) {
  return [...String(html).matchAll(/<div class="attr ([a-z_ -]+)"[^>]*>([\s\S]*?)<\/div>/g)]
    .map(m => strip(m[2]))
    .filter(Boolean);
}

/**
 * A posting page -> the shape HavenIQ stores, or null when it is not a rental
 * we can represent.
 *
 * Returns null rather than guessing. A posting with no price or no location is
 * not a listing a student can act on, and inventing either is worse than
 * skipping it — the whole point of the moderation queue downstream is that
 * only real, checkable things reach a student.
 */
function parsePosting(html, url) {
  const title = strip(first(html, /<meta property="og:title" content="([^"]*)"/)
    || first(html, /<title>([^<]*)<\/title>/));
  if (!title) return null;

  // A parking space or a storage unit is not somewhere to live.
  const cat = subcategory(html);
  if (cat && !RENTAL_CATS.has(cat)) return null;

  const cents = priceCents(html);
  const { lat, lon } = coords(html);
  // No price or no location: not actionable, so not stored.
  if (cents == null || lat == null) return null;

  const { beds, baths, isStudio } = bedsBaths(html);
  const body = strip(first(html, /<section id="postingbody">([\s\S]*?)<\/section>/))
    .replace(/^QR Code Link to This Post\s*/i, '');
  const attrs = attributes(html);
  const postedAt = first(html, /<time[^>]*datetime="([^"]+)"/);

  return {
    sourceUrl: url,
    subcategory: cat,
    title: cleanTitle(title),
    // Null when the posting maps no street address; the caller derives one
    // from the coordinates rather than inventing it here.
    address: mapAddress(html),
    totalRentCents: cents,
    beds: beds ?? 1,
    baths: baths ?? 1,
    isStudio,
    latitude: lat,
    longitude: lon,
    postedAt: postedAt || null,
    // The body plus the attribute chips, which is what the scam scorer reads.
    notes: [body, attrs.length ? attrs.join(' · ') : null].filter(Boolean).join('\n\n').slice(0, 4000),
    attrs,
  };
}

/**
 * Posting URLs for a region — the shared adapter contract.
 *
 * Craigslist needs two hops: a 2,800-entry index, then the one regional
 * housing sitemap out of it. Uloop needs one. The collector should not have to
 * know which, so each adapter owns its own discovery and is handed the
 * collector's polite fetcher to do it with. That keeps the robots gate and the
 * rate limit in ONE place rather than duplicated per source, where a new
 * adapter could quietly forget them.
 */
async function collectUrls(politeFetch, region) {
  const index = await politeFetch(SITEMAP_INDEX);
  if (!index.ok) return { urls: [], blocked: !!index.blocked, error: index.reason || index.status || index.error };

  const sitemaps = housingSitemapsFor(index.body, region);
  if (!sitemaps.length) return { urls: [], error: `no housing sitemap for region "${region}"` };

  const sm = await politeFetch(sitemaps[0]);
  if (!sm.ok) return { urls: [], blocked: !!sm.blocked, error: sm.reason || sm.status || sm.error };

  return { urls: locs(sm.body) };
}

module.exports = {
  NAME: 'craigslist',
  collectUrls,
  SITEMAP_INDEX, CATEGORY,
  locs, housingSitemapsFor, parsePosting, cleanTitle, subcategory, mapAddress, RENTAL_CATS,
  priceCents, bedsBaths, coords, attributes, strip,
};
