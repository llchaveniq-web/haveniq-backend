/**
 * Uloop source adapter — student housing, by campus.
 *
 * WHY THIS SOURCE
 *
 * Uloop runs a per-campus subdomain for hundreds of universities
 * (ucla.uloop.com, berkeley.uloop.com…), which maps directly onto HavenIQ's
 * school_near instead of needing a metro-to-campus guess the way Craigslist
 * does. UCLA's sitemap alone carries 1,020 housing entries.
 *
 * Its robots.txt disallows a dozen specific news articles, /assets/ and a
 * couple of utility endpoints — housing is not restricted — and it explicitly
 * Allows GPTBot and OAI-SearchBot. It serves HavenIQBot a 200. This is a site
 * that expects to be read by machines.
 *
 * WHAT A LISTING HERE ACTUALLY IS
 *
 * Mostly a BUILDING, not a unit. A page carries schema.org LocalBusiness JSON-LD
 * with a real street address and coordinates, plus a priceRange across every
 * floorplan — "$2,882-$7,744 / month" spanning 1BR and 2BR units.
 *
 * That is a different shape from Craigslist, where a posting is one place at
 * one price, and it is handled honestly rather than flattened: the low end of
 * the range is stored as the rent, the low bed count as the beds, and the FULL
 * range goes in the notes so the moderator and the student both see that it is
 * a from-price on a building. Storing the midpoint, or the high end, or
 * pretending a range is a single unit, would each be a quiet lie about the one
 * number a student decides on.
 */

const SITEMAP_FOR = (campus) => `https://${campus}.uloop.com/sitemap.xml`;
const NAME = 'uloop';

/** Pull every <loc>. The sitemap is one 4.8 MB urlset with no newlines. */
function locs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
}

/** Housing detail pages only — the sitemap also carries jobs, tutors, travel. */
function housingUrls(xml) {
  return locs(xml).filter(u => /\/housing\/view\.php\//.test(u));
}

/** The LocalBusiness node from the page's schema.org @graph, or null. */
function localBusiness(html) {
  for (const m of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    const nodes = parsed['@graph'] || (Array.isArray(parsed) ? parsed : [parsed]);
    const hit = nodes.find(n => n && /LocalBusiness|ApartmentComplex|Residence/i.test(n['@type'] || ''));
    if (hit) return hit;
  }
  return null;
}

/**
 * "$2,882-$7,744" -> { lowCents, highCents }.
 *
 * The LOW end becomes the stored rent. A student filtering by budget is asking
 * "can I live here", and the cheapest floorplan is the honest answer to that;
 * the high end would hide buildings they could actually afford.
 */
function priceRange(raw) {
  const nums = [...String(raw || '').matchAll(/\$\s?([\d,]+)/g)]
    .map(m => Number(m[1].replace(/,/g, '')))
    .filter(n => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  return { lowCents: Math.round(Math.min(...nums) * 100), highCents: Math.round(Math.max(...nums) * 100) };
}

/** A splash screen, logo or placeholder is not a photo of the building. */
const PLACEHOLDER_RE = /splash|placeholder|logo|default|favicon|no.?image/i;

/**
 * The property's photo, or null when the page is only offering a placeholder.
 *
 * Three places to look, because the obvious one is always wrong. Uloop's
 * JSON-LD `image` is its own splash screen on EVERY housing page — reading only
 * that produced 376 collected listings with no photo while the pages carried
 * real ones the whole time.
 *
 *   1. JSON-LD image      genuine on the rare page that sets one
 *   2. og:image           usually the real photo, on Uloop's rentalbeast CDN
 *   3. data-src gallery   lazy-loaded, so it never appears in a src attribute
 *
 * Storing the splash would be worse than storing nothing: it puts one identical
 * graphic on hundreds of cards as though each were a picture of the place, and
 * a reviewer scanning the queue reads that as "this one has a photo".
 */
function photoUrl(biz, html = '') {
  const fromLd = biz && biz.image && biz.image.url;
  if (typeof fromLd === 'string' && fromLd && !PLACEHOLDER_RE.test(fromLd)) return fromLd;

  const og = String(html).match(/<meta property="og:image" content="([^"]+)"/);
  if (og && !PLACEHOLDER_RE.test(og[1])) return og[1];

  // Protocol-relative ("//d31gnh3j8cblbd.uloop.com/..."), so it needs a scheme
  // before anything can load it.
  const lazy = String(html).match(/data-src="((?:https?:)?\/\/[^"]+)"/);
  if (lazy && !PLACEHOLDER_RE.test(lazy[1])) {
    return lazy[1].startsWith('//') ? 'https:' + lazy[1] : lazy[1];
  }
  return null;
}

/** Bed counts advertised anywhere on the page, ascending and de-duplicated. */
function bedCounts(html) {
  const found = [...String(html).matchAll(/(\d+)\s*BR\b/gi)]
    .map(m => Number(m[1]))
    .filter(n => Number.isFinite(n) && n >= 0 && n <= 10);
  return [...new Set(found)].sort((a, b) => a - b);
}

/**
 * A Uloop housing page -> the shape HavenIQ stores, or null.
 *
 * Null whenever the address, coordinates or price are missing. Unlike
 * Craigslist there is no reverse-geocode fallback needed here: if this page
 * has no streetAddress it is not a property listing worth storing.
 */
function parsePosting(html, url) {
  const biz = localBusiness(html);
  if (!biz) return null;

  const addr = biz.address || {};
  const street = String(addr.streetAddress || '').trim();
  const lat = Number(biz.geo && biz.geo.latitude);
  const lon = Number(biz.geo && biz.geo.longitude);
  const range = priceRange(biz.priceRange);

  if (!street || !range) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const beds = bedCounts(html);
  // 0BR is a studio; the listings table CHECKs beds BETWEEN 1 AND 10.
  const lowBeds = beds.length ? Math.max(1, beds[0]) : 1;

  const isRange = range.highCents > range.lowCents;
  const money = (c) => '$' + Math.round(c / 100).toLocaleString('en-US');
  const summary = [
    isRange ? `Rent ${money(range.lowCents)}–${money(range.highCents)}/mo across floorplans.` : null,
    beds.length > 1 ? `Floorplans: ${beds.map(b => (b === 0 ? 'studio' : `${b}BR`)).join(', ')}.` : null,
    'Building listing — the price shown is the lowest floorplan.',
  ].filter(Boolean).join(' ');

  return {
    sourceUrl: url,
    title: String(biz.name || street).trim(),
    address: street,
    city: addr.addressLocality || null,
    totalRentCents: range.lowCents,
    highRentCents: range.highCents,
    beds: lowBeds,
    // NOT KNOWN. Uloop does not advertise baths per building, and this used to
    // write 1 and call it "the safe floor" — which put an invented number on
    // every Uloop listing and showed it to students as fact. There is no safe
    // floor for a figure someone decides on; null is the only true value.
    baths: null,
    isStudio: beds[0] === 0,
    isRange,
    latitude: lat,
    longitude: lon,
    postedAt: null,                  // Uloop does not date its housing pages
    photoUrl: photoUrl(biz, html),
    notes: [summary, String(biz.description || '').trim()].filter(Boolean).join('\n\n').slice(0, 4000),
  };
}

/**
 * Posting URLs for a campus — the shared adapter contract.
 *
 * `region` here is the campus subdomain ("ucla", "berkeley"), not a metro. One
 * fetch: Uloop publishes a single flat urlset per campus rather than an index.
 */
async function collectUrls(politeFetch, region) {
  const sm = await politeFetch(SITEMAP_FOR(region));
  if (!sm.ok) return { urls: [], blocked: !!sm.blocked, error: sm.reason || sm.status || sm.error };
  return { urls: housingUrls(sm.body) };
}

module.exports = {
  NAME, SITEMAP_FOR, collectUrls,
  locs, housingUrls, parsePosting,
  localBusiness, priceRange, bedCounts, photoUrl,
};
