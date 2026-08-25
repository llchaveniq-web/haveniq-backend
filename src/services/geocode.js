/**
 * Geocoding — turn a listing's street address into coordinates.
 *
 * Listings have carried an address and nothing else, which is why the app can
 * only hand students a Google Maps *text search*. A text search is a guess: it
 * resolves "412 Bardeen Ave" against the whole planet and can confidently drop
 * someone at the wrong Bardeen Ave. Coordinates make the pin exact, and they're
 * the prerequisite for every map feature worth having (radius, walking
 * distance, a real map view).
 *
 * PROVIDER: Nominatim (OpenStreetMap). Chosen because it needs no API key —
 * this backend has no maps key of any kind, and adding a billable Google/Mapbox
 * dependency to geocode a founder-curated trickle of listings would be a poor
 * trade. Nominatim's usage policy asks for an identifying User-Agent and at
 * most one request per second; both are honoured below.
 *
 * FAILURE IS NORMAL AND FINE. Every function here returns null rather than
 * throwing. A listing without coordinates behaves exactly as listings did
 * before this file existed — the app falls back to the address text search — so
 * a geocoder outage degrades the feature instead of breaking listing creation.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'HavenIQ/1.0 (student housing listings; noreply@haveniq.org)';
const TIMEOUT_MS = 8000;

// Nominatim asks for <= 1 request/second. Listings are created one at a time by
// a founder, so this will essentially never engage — but a backfill loop would
// hammer them without it, and being a bad citizen of a free service is how you
// lose access to it.
const MIN_INTERVAL_MS = 1100;
let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/**
 * Build the query string. City and a nearby school both disambiguate a street
 * address that repeats across towns — the same reasoning as the app's
 * mapSearchUrl, kept deliberately in sync.
 */
function buildQuery({ address, city, schoolNear }) {
  return [address, city, schoolNear]
    .map(p => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(', ');
}

/**
 * { lat, lon } for an address, or null.
 *
 * Null covers every failure: no address, provider down, timeout, no result,
 * malformed response, or coordinates outside the valid range. Callers treat
 * null as "we don't know where this is", which is a state the product already
 * handles everywhere.
 */
async function geocodeListing({ address, city, schoolNear }) {
  if (!address || typeof address !== 'string' || !address.trim()) return null;
  return geocodeOne(buildQuery({ address, city, schoolNear }));
}

/** The shared lookup. Every caller gets the same throttle and the same
 *  rejection rules, so a new call site can't quietly skip either. */
async function geocodeOne(q) {
  const url = `${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;

  try {
    await throttle();
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const body = await res.json();
    if (!Array.isArray(body) || !body.length) return null;

    const lat = Number(body[0].lat);
    const lon = Number(body[0].lon);
    // A NaN or an out-of-range pair would be stored happily by Postgres and
    // then put a student in the ocean. Reject rather than persist nonsense.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

    return { lat, lon };
  } catch {
    return null;
  }
}

/**
 * Coordinates for a campus, by the school NAME as stored on the user row.
 *
 * Appending "university" is deliberately NOT done: names here are already
 * full ("University of Southern California", "UC Irvine"), and bolting a word
 * onto a name that already contains it is how a query stops matching.
 */
async function geocodeSchool(school) {
  if (!school || typeof school !== 'string' || !school.trim()) return null;
  return geocodeOne(school.trim());
}

/**
 * Great-circle distance in miles.
 *
 * Straight-line, not walking distance — and the UI must say so. Presenting a
 * crow-flies number as "N minutes' walk" would be a lie in any city with a
 * river, a freeway or a hill between two points, which is most of them.
 */
function haversineMiles(a, b) {
  if (!a || !b) return null;
  const R = 3958.7613;                       // mean Earth radius, miles
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = { geocodeListing, geocodeSchool, buildQuery, haversineMiles };
