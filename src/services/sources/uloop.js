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

/**
 * The property's photo, or null when the page is only offering a placeholder.
 *
 * Uloop's JSON-LD falls back to its own splash screen when a listing has no
 * image. Storing that would put the identical stock graphic on every listing
 * as though it were the building — a small dishonesty, and exactly the kind
 * that erodes the "no fake listings" claim. A listing with no photo is honest;
 * a listing wearing someone's logo is not.
 */
function photoUrl(biz) {
  const url = biz && biz.image && biz.image.url;
  if (!url || typeof url !== 'string') return null;
  if (/splash|placeholder|logo|default|no.?image/i.test(url)) return null;
  return url;
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
    baths: 1,                        // not advertised per building; the safe floor
    isStudio: beds[0] === 0,
    isRange,
    latitude: lat,
    longitude: lon,
    postedAt: null,                  // Uloop does not date its housing pages
    photoUrl: photoUrl(biz),
    notes: [summary, String(biz.description || '').trim()].filter(Boolean).join('\n\n').slice(0, 4000),
  };
}

module.exports = {
  NAME, SITEMAP_FOR,
  locs, housingUrls, parsePosting,
  localBusiness, priceRange, bedCounts, photoUrl,
};
