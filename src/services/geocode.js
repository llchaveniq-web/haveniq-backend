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
async function geocodeOne(q, { limit = 1, prefer = null } = {}) {
  const url = `${NOMINATIM}?format=jsonv2&limit=${limit}&q=${encodeURIComponent(q)}`;

  try {
    await throttle();
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const body = await res.json();
    if (!Array.isArray(body) || !body.length) return null;

    // `prefer` lets a caller say what KIND of thing it is looking for and take
    // that over Nominatim's own ranking. Free-text ranking optimises for string
    // similarity, not for "is this the institution I named" — see geocodeSchool.
    const hit = (prefer && body.find(r => prefer.test(String(r.type || '')))) || body[0];

    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    // A NaN or an out-of-range pair would be stored happily by Postgres and
    // then put a student in the ocean. Reject rather than persist nonsense.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

    return { lat, lon };
  } catch {
    return null;
  }
}

// A campus is a university, a college or a school. Nominatim's `type` for the
// real thing is one of these; a bus stop named after it, or an apartment block
// that borrowed its name, is not.
const CAMPUS_TYPE = /^(university|college|school)$/;

/**
 * Coordinates for a campus, by the school NAME as stored on the user row.
 *
 * Appending "university" is deliberately NOT done: names here are already
 * full ("University of Southern California", "UC Irvine"), and bolting a word
 * onto a name that already contains it is how a query stops matching.
 *
 * ── Why this is not just geocodeOne(school) ────────────────────────────────
 *
 * It was, and it was wrong by 383 miles. "University of California, Berkeley"
 * returned a point in IRVINE: Nominatim reads the comma as an address
 * separator, so the official name becomes a street-address-shaped query and
 * "Berkeley Court Apartments, University Town Center, Irvine" scores as an
 * excellent match. "University of California, Los Angeles" returned Cal State
 * LA. "University of California, San Diego" returned a school district office.
 *
 * Nothing above caught it. The range checks reject NaN and coordinates outside
 * the planet — a plausible-looking point in the wrong city passes every one,
 * gets cached by getSchoolCoords with ON CONFLICT DO NOTHING, and sticks. The
 * student then sees listings from a city they have never been to, filtered by
 * a radius drawn around the wrong campus.
 *
 * Two changes fix all eight schools currently in production to within 1.6 mi:
 *
 *   1. Drop the commas. The official names are comma-separated, which is
 *      exactly what makes Nominatim parse them as addresses.
 *   2. Ask for several results and take the one TYPED as a campus, rather than
 *      whatever ranked first by string similarity.
 *
 * No country restriction: the app accepts .ac.uk and .edu.au addresses, and
 * pinning to the US would silently break every school outside it. Verified
 * without it.
 */
async function geocodeSchool(school) {
  if (!school || typeof school !== 'string' || !school.trim()) return null;
  const q = school.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  return geocodeOne(q, { limit: 8, prefer: CAMPUS_TYPE });
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

/**
 * Coordinates -> a street address. The inverse of the rest of this file.
 *
 * Needed because Craigslist gives every posting coordinates but only about six
 * in ten a mapped street address, while listings.address is NOT NULL. Deriving
 * the address FROM the posting's own coordinates is honest; inventing one, or
 * filing "near 3rd street" as the location of a home, is not.
 *
 * Same throttle and the same never-throws contract as the forward lookup.
 * Returns null when it cannot answer, and the caller decides whether a listing
 * without an address is worth keeping.
 */
async function reverseGeocode(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18`;
  try {
    await throttle();
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const a = body && body.address;
    if (!a) return null;

    const house = a.house_number || '';
    const road = a.road || a.pedestrian || a.footway || '';
    // A road with no number is a street, not an address. Returned anyway when
    // that is all there is — it still locates the listing on a map — but the
    // scam scorer's thin_address rule will flag it for a human, which is the
    // right outcome for a place we cannot pin to a building.
    const street = [house, road].filter(Boolean).join(' ').trim();
    if (!street) return null;

    return {
      address: street,
      city: a.city || a.town || a.village || a.suburb || a.neighbourhood || null,
    };
  } catch {
    return null;
  }
}

module.exports = { geocodeListing, geocodeSchool, reverseGeocode, buildQuery, haversineMiles };
