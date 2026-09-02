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

/**
 * Is the advertised price for ONE room, not the whole place?
 *
 * In `roo` (rooms & shares) the number on the posting is what one person pays
 * for one room. The collector divides a whole-unit rent by the bed count to
 * get per-person, which is right for an apartment and badly wrong here: it
 * understates a room by exactly the number of bedrooms. A real $650 room in a
 * 3BR was stored as $216 — a figure no room in Los Angeles is let at, and one
 * that reads as a bargain rather than as an error.
 *
 * Matched on the TITLE, never the body. The body of an ordinary whole-unit
 * listing describes the rooms inside it: a 3-bed Redondo Beach condo at $6,450
 * mentions its master bedroom, and reading that as "a room is for rent" tripled
 * its per-person rent. What is FOR RENT is what the title says is for rent.
 *
 * Deliberately the RAW og:title, before cleanTitle() strips the trailing
 * "- rooms & shares - apartment room" boilerplate. That suffix is Craigslist's
 * own category label, and it survives on the canonical /view/d/ pages that
 * carry no cat= breadcrumb — so it is the more reliable of the two signals,
 * not noise to be cleaned off before looking.
 */
const ROOM_SHARE_RE = /\b(?:p(?:riva|v)te?\s+room|room\s+for\s+rent|rooms?\s+(?:&|and)\s+shares?|master\s+bedroom|own\s+room|roommates?\s+wanted|room\s+in\s+(?:a|an|my|the)|shared?\s+room)\b/i;

function pricedPerPerson(cat, title) {
  if (cat === 'roo') return true;
  return ROOM_SHARE_RE.test(String(title));
}

/**
 * Things in the housing sitemap that are not somewhere to live.
 *
 * RENTAL_CATS drops parking and storage when the breadcrumb declares a
 * subcategory, but Craigslist serves canonical /view/d/ URLs carrying none, so
 * that is the common case rather than the corner. Title-only for the same
 * reason as above — an apartment advertising an assigned parking space or extra
 * storage space is still an apartment.
 */
const NOT_HOUSING_RE = /\b(?:office\s+space|private\s+office|desk\s+space|coworking|parking\s+(?:space|spot|stall)|storage\s+(?:unit|space)|garage\s+for\s+rent|commercial\s+(?:space|unit|property)|retail\s+space|warehouse)\b/i;

/**
 * The rent period the posting itself declares, lower-cased, or null.
 *
 * Craigslist publishes this as an attribute chip — "rent period: monthly" —
 * which beats inferring it from prose. An "AirBnBish" posting at $25 was stored
 * as $25 a MONTH; the field says nightly and settles it, where guessing from
 * the word "weekly" threw out a sober-living house that advertised weekly AND
 * monthly rates and was a perfectly real monthly rental.
 */
function rentPeriod(attrs) {
  const hit = (attrs || []).find(a => /^rent\s+period\s*:/i.test(a));
  return hit ? hit.replace(/^rent\s+period\s*:\s*/i, '').trim().toLowerCase() : null;
}

/** Short-stay wording in a TITLE, used only when no rent-period chip exists. */
const SHORT_STAY_RE = /\b(?:air\s?bnb\w*|short[- ]?stay|per\s+night|nightly|hostel)\b/i;

/** Street address when the posting maps one. Roughly 6 in 10 do. */
function mapAddress(html) {
  const raw = first(html, /<div class="mapaddress">([\s\S]*?)<\/div>/);
  const addr = strip(raw);
  // "near 3rd street" on its own is a cross-street, not an address — useful
  // as context but not something to file as the location of a home.
  return addr && /\d/.test(addr) ? addr : null;
}

/**
 * The posting's first photo, or null.
 *
 * og:image is the largest one Craigslist advertises. Postings with no picture
 * fall back to the site's own logo, which must NOT be stored: it would put an
 * identical graphic on hundreds of cards as though each were a photo of the
 * place, and a reviewer scanning the queue would read that as "has a photo".
 * Same reasoning as Uloop's splash-screen guard — a listing with no photo is
 * honest, one wearing someone's logo is not.
 */
function photoUrl(html) {
  const url = first(html, /<meta property="og:image" content="([^"]+)"/);
  if (!url) return null;
  if (/craigslist_logo|\/logo|peace\.(?:jpg|png)|default/i.test(url)) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * When the place is free, from the attribute group, or null.
 *
 * Craigslist writes it into the same string the bed count comes from:
 *
 *   "2BR / 1Ba 1100ft2 available sep 1"
 *   "2BR / 1Ba  950ft2 available now"
 *   "2BR / 2Ba  953ft2"                  <- plenty simply do not say
 *
 * bedsBaths() has been reading that string all along and throwing this away.
 *
 * Null when absent, and null when unparseable — never today-as-a-fallback. A
 * guessed move-in date is the kind of invented fact that put a fabricated
 * bathroom count on half the listings; "we were not told" is a real answer and
 * the column is nullable so it can be given.
 *
 * `now` is injected so the year rollover is testable rather than a thing that
 * only misbehaves each December.
 */
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function availableFrom(html, now = new Date()) {
  const text = strip(first(html, /<div class="attrgroup">([\s\S]*?)<\/div>/));
  if (!text) return null;

  if (/available\s+now/i.test(text)) return now.toISOString().slice(0, 10);

  const m = text.match(/available\s+([a-z]{3,9})\.?\s+(\d{1,2})\b/i);
  if (!m) return null;

  const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  const day = Number(m[2]);
  if (mon < 0 || !(day >= 1 && day <= 31)) return null;

  // No year is given. A month already behind us means next year — a posting
  // put up in November saying "available feb 1" means the coming February,
  // not one nine months gone.
  let year = now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, mon, day));
  if (candidate < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) {
    year += 1;
  }
  const d = new Date(Date.UTC(year, mon, day));
  // Rejects the 31st of a 30-day month rather than letting it roll into the next.
  if (d.getUTCMonth() !== mon) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Every photo on the posting, largest first in the order the seller arranged
 * them.
 *
 * A posting carries eight or so; we stored one and called it the photo. Photos
 * are the first thing a student looks at and the fastest way to tell a real
 * listing from a re-used stock shot, so a single image was throwing away most
 * of what makes a card trustworthy.
 *
 * De-duplicated by image id because the same picture appears more than once in
 * the markup (the visible slide and the thumbnail strip), and capped: a
 * twenty-photo posting is not twenty times more informative, and every URL
 * here is a request some phone eventually makes.
 */
const MAX_PHOTOS = 10;

function photoUrls(html) {
  const seen = new Set();
  const out = [];
  for (const m of String(html).matchAll(/https:\/\/images\.craigslist\.org\/([A-Za-z0-9_]+)_(\d+x\d+)\.jpg/g)) {
    const [url, id] = [m[0], m[1]];
    if (seen.has(id)) continue;
    if (/craigslist_logo|peace|default/i.test(url)) continue;
    seen.add(id);
    out.push(url);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
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

  // Second gate, for the pages whose breadcrumb declares no subcategory.
  if (NOT_HOUSING_RE.test(title)) return null;
  // A nightly rate stored as a monthly rent is off by roughly thirty times.
  // The posting's own rent-period field decides when it has one.
  const period = rentPeriod(attrs);
  if (period ? period !== 'monthly' : SHORT_STAY_RE.test(title)) return null;

  // Per-person rent is derived by dividing the total by the bed count, so a
  // whole-unit posting that never states its beds cannot be described
  // truthfully — this used to write 1 and quote the entire rent as one
  // person's share. A room is different: its price is already per person, so
  // the bed count does not enter the arithmetic and 1 is what the tenant
  // actually gets.
  const perPerson = pricedPerPerson(cat, title);
  if (beds == null && !perPerson) return null;

  return {
    sourceUrl: url,
    subcategory: cat,
    title: cleanTitle(title),
    // Null when the posting maps no street address; the caller derives one
    // from the coordinates rather than inventing it here.
    address: mapAddress(html),
    totalRentCents: cents,
    // The collector divides by beds to get per-person. For a room the price
    // ALREADY is per-person, so it must not be divided again.
    pricedPerPerson: perPerson,
    beds: beds ?? 1,           // only reachable when the price is per person
    // Null when the posting does not state it, rather than 1. A default here
    // is indistinguishable from a parsed value once it is in the database.
    baths,
    isStudio,
    latitude: lat,
    longitude: lon,
    postedAt: postedAt || null,
    availableFrom: availableFrom(html),
    photoUrl: photoUrl(html),
    photoUrls: photoUrls(html),
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
  pricedPerPerson, rentPeriod, photoUrl, photoUrls, availableFrom,
  ROOM_SHARE_RE, NOT_HOUSING_RE, SHORT_STAY_RE,
  priceCents, bedsBaths, coords, attributes, strip,
};
