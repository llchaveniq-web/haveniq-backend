const router = require('express').Router();
const { notifyNewListing } = require('../services/listingAlerts');
const { geocodeListing, geocodeSchool, haversineMiles } = require('../services/geocode');
const { assessListing } = require('../services/listingRisk');
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { isFounder }   = require('../utils/founders');
const ht = require('../services/housingTiming');

/**
 * Campus coordinates for a school name, geocoded once and cached forever.
 *
 * Schools aren't a table here, so the cache is keyed by the name as stored.
 * A row EXISTS as soon as we've tried, with NULL coordinates when the name
 * couldn't be resolved — that's what stops an unresolvable school being
 * re-geocoded on every single listings request.
 *
 * Returns null on any failure. Distance is an enhancement; the listings must
 * still come back without it.
 */
async function getSchoolCoords(school) {
  if (!school) return null;
  try {
    const { rows } = await pool.query(
      'SELECT latitude, longitude FROM school_coords WHERE school = $1',
      [school],
    );
    if (rows.length) {
      const r = rows[0];
      return r.latitude == null ? null : { lat: Number(r.latitude), lon: Number(r.longitude) };
    }

    const coords = await geocodeSchool(school);
    // Write the row either way. A miss cached as a row is the difference
    // between one failed lookup and one per request forever.
    await pool.query(
      `INSERT INTO school_coords (school, latitude, longitude)
       VALUES ($1, $2, $3)
       ON CONFLICT (school) DO NOTHING`,
      [school, coords?.lat ?? null, coords?.lon ?? null],
    );
    return coords ? { lat: coords.lat, lon: coords.lon } : null;
  } catch (err) {
    console.error('[schoolCoords] failed:', err.message);
    return null;
  }
}

// Bot-token gate for the manual ingest trigger (same pattern as matchOutcomes).
// The shared internal-endpoint guard. This was previously a try/require with an
// inline fallback — and because middleware/botAuth.js did not exist, the
// fallback is what actually ran: it compared the secret with a plain string
// comparison, which leaks how much of it matched through response timing.
// Requiring directly makes a missing module a loud boot error rather than a
// silent downgrade to the weaker check.
const { requireBotToken } = require('../middleware/botAuth');

// ── GET /housing/listings ──────────────────────────────────────────────────
// Active listings near the caller's school, optionally filtered by max
// per-person budget. Authenticated to discourage scraping; not paywalled.
router.get('/listings', requireAuth, async (req, res) => {
  try {
    const { rows: userRows } = await pool.query('SELECT school FROM users WHERE id = $1', [req.user.id]);
    const callerSchool = req.query.school || userRows[0]?.school || null;
    const maxPerPerson = req.query.maxPrice ? Math.round(Number(req.query.maxPrice) * 100) : null;
    const minBeds      = req.query.minBeds  ? Number(req.query.minBeds) : null;
    // The cap used to be a hardcoded 50. With a collector filing hundreds of
    // listings per campus that silently became the product: a student filtering
    // by price was filtering 50 rows, not the market, and the 51st cheapest
    // place near campus simply did not exist as far as the app was concerned.
    // Capped at 500 so one request cannot ask for a whole table.
    // How far from campus still counts as "near". Wide by default: USC to
    // downtown is 3 miles, UCLA to USC is 12, and Orange Coast College sits 35
    // from central LA — a tight radius would quietly re-create the empty tab.
    const radiusMi = Math.min(Math.max(Number(req.query.radiusMi) || 30, 1), 200);
    const limit  = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // WHERE a listing is, not what it was labelled.
    //
    // school_near is a label the collector writes, and a metro-wide source
    // cannot honestly pick one campus: every Craigslist LA posting went in
    // tagged 'UCLA' because that was the configured target, which made 480
    // real listings invisible to the 14 USC students on the app and the 3 at
    // Orange Coast College. Nobody was at UCLA. A downtown apartment is near
    // USC whatever a label says.
    //
    // So the filter is distance from the caller's campus when we know where
    // both ends are. A bounding box does the cheap cut in SQL — it is a plain
    // range scan rather than trigonometry over every row — and the exact
    // haversine below trims the corners of that box, which are up to 41% too
    // far out at the diagonal.
    const campus = await getSchoolCoords(callerSchool);
    // ~69 miles per degree of latitude; longitude degrees shrink with cos(lat).
    const latPad = campus ? radiusMi / 69 : null;
    const lonPad = campus ? radiusMi / (69 * Math.max(0.1, Math.cos(campus.lat * Math.PI / 180))) : null;

    const { rows } = await pool.query(
      `SELECT id, address, city, school_near, beds, baths,
              latitude, longitude,
              total_rent_cents, high_rent_cents, per_person_rent_cents, photo_url,
              contact_name, contact_email, contact_phone, available_from, notes, created_at,
              source, source_url
       FROM listings
       WHERE is_active = TRUE
         -- A listing a human has not cleared is not shown to a student.
         -- This is the line the "no fake listings" promise rests on.
         AND moderation_status = 'approved'
         AND (
           $1::text IS NULL
           OR (
             -- In the box around campus...
             $6::numeric IS NOT NULL
             AND latitude  BETWEEN $6::numeric - $8::numeric AND $6::numeric + $8::numeric
             AND longitude BETWEEN $7::numeric - $9::numeric AND $7::numeric + $9::numeric
           )
           -- ...or carrying no coordinates at all, in which case its label is
           -- the only thing that can place it and we fall back to that.
           OR (latitude IS NULL AND school_near = $1)
           -- ...or we could not locate the campus, so distance is not on offer.
           OR ($6::numeric IS NULL AND school_near = $1)
         )
         AND ($2::integer IS NULL OR per_person_rent_cents <= $2)
         AND ($3::integer IS NULL OR beds >= $3)
       ORDER BY created_at DESC
       LIMIT $4 OFFSET $5`,
      [callerSchool, maxPerPerson, minBeds, limit, offset,
       campus?.lat ?? null, campus?.lon ?? null, latPad, lonPad],
    );

    // Straight-line distance from campus, when we know where both ends are.
    // Deliberately computed here rather than in SQL: it needs a network
    // geocode on a cache miss, and a listing with no coordinates simply has no
    // distance rather than being excluded from the results.
    const mapped = rows.map(r => ({
        id:           r.id,
        address:      r.address,
        city:         r.city,
        schoolNear:   r.school_near,
        beds:         r.beds,
        // Number(null) is 0, which would print "0 baths" — a confident
        // falsehood where the truth is that we do not know.
        baths:        r.baths == null ? null : Number(r.baths),
        // NUMERIC comes back from pg as a STRING. Number() here, or the app
        // receives "33.64" where it expects 33.64 and every distance
        // calculation downstream silently becomes string concatenation.
        lat:          r.latitude  == null ? null : Number(r.latitude),
        lng:          r.longitude == null ? null : Number(r.longitude),
        // Miles, straight-line. NOT walking distance, and the app labels it
        // as such: a crow-flies number sold as "N minutes' walk" is a lie in
        // any city with a river or a freeway in the way.
        distanceMi:   (campus && r.latitude != null)
          ? Math.round(haversineMiles(campus, { lat: Number(r.latitude), lon: Number(r.longitude) }) * 10) / 10
          : null,
        totalRent:    r.total_rent_cents / 100,
        // Present only when the source quoted a RANGE, which is what makes the
        // headline a "from" price rather than the price. The card says so next
        // to the number; it used to be explained in a sentence at the end of
        // notes, which the card truncates before reaching the point.
        totalRentHigh: r.high_rent_cents == null ? null : r.high_rent_cents / 100,
        perPerson:    r.per_person_rent_cents / 100,
        photoUrl:     r.photo_url,
        contactName:  r.contact_name,
        // The browse list's Email and Call actions read these. They were
        // absent from this DTO, so handleInquire always fell to its "no
        // contact email" branch and the Call button never rendered.
        contactEmail: r.contact_email,
        contactPhone: r.contact_phone,
        // Where this listing came from, and the posting it came from.
        //
        // A collected listing has no contact details at all — Craigslist
        // relays mail and exposes no address, and a Uloop page is a building
        // rather than a person. Without these two fields such a listing reaches
        // a student as a dead end: a price, a photo, and no way to enquire.
        // The app shows "View on <source>" and hands them back to the original.
        source:       r.source,
        sourceUrl:    r.source_url,
        availableFrom: r.available_from,
        notes:        r.notes,
        createdAt:    r.created_at,
      }));

    // Trim the corners the bounding box let through. A square around a circle
    // reaches sqrt(2) — about 41% — further at the diagonal than the radius,
    // so without this a 30-mile search returns places up to 42 miles away in
    // the north-east and nowhere in particular in the north.
    //
    // A listing with no distance is kept: it either has no coordinates or the
    // campus could not be located, and in both cases it got here on its label,
    // which the SQL above already checked.
    const listings = mapped.filter(l => l.distanceMi == null || l.distanceMi <= radiusMi);

    res.json({ listings });
  } catch (err) {
    console.error('listings fetch failed:', err);
    res.status(500).json({ error: 'Failed to load listings' });
  }
});

// ── GET /housing/listings/:id ─────────────────────────────────────────────
router.get('/listings/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, address, city, school_near, beds, baths,
              latitude, longitude,
              total_rent_cents, high_rent_cents, per_person_rent_cents, photo_url,
              contact_name, contact_email, contact_phone, available_from, notes, created_at,
              source, source_url
       FROM listings
       WHERE id = $1 AND is_active = TRUE AND moderation_status = 'approved'`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Listing not found' });
    const r = rows[0];
    res.json({
      id:            r.id,
      address:       r.address,
      city:          r.city,
      schoolNear:    r.school_near,
      beds:          r.beds,
      baths:         r.baths == null ? null : Number(r.baths),
      // pg returns NUMERIC as a string; Number() or the app gets "33.64".
      lat:           r.latitude  == null ? null : Number(r.latitude),
      lng:           r.longitude == null ? null : Number(r.longitude),
      totalRent:     r.total_rent_cents / 100,
      totalRentHigh: r.high_rent_cents == null ? null : r.high_rent_cents / 100,
      perPerson:     r.per_person_rent_cents / 100,
      photoUrl:      r.photo_url,
      contactName:   r.contact_name,
      contactEmail:  r.contact_email,
      contactPhone:  r.contact_phone,
      // See the browse list: without these a collected listing is a dead end.
      source:        r.source,
      sourceUrl:     r.source_url,
      availableFrom: r.available_from,
      notes:         r.notes,
      createdAt:     r.created_at,
    });
  } catch (err) {
    console.error('listing fetch failed:', err);
    res.status(500).json({ error: 'Failed to load listing' });
  }
});

// ── POST /housing/listings ─────────────────────────────────────────────────
// Founder-only until we onboard real property managers. The frontend
// admin screen (see app/admin/) gates entry behind founder ID too — this
// is the server-side enforcement.
router.post('/listings', requireAuth, async (req, res) => {
  if (!isFounder(req.user.id)) {
    return res.status(403).json({ error: 'Listings are founder-curated for now' });
  }

  const {
    address, city, schoolNear, beds, baths,
    totalRent, perPerson, photoUrl, contactName, contactEmail, contactPhone,
    availableFrom, notes,
  } = req.body || {};

  if (!address || !schoolNear || !beds || !baths || !totalRent || !perPerson) {
    return res.status(400).json({ error: 'address, schoolNear, beds, baths, totalRent, perPerson are required' });
  }

  // Score BEFORE the insert, so the verdict is stored with the row rather
  // than bolted on afterwards by a job that might not run. Rule-based and
  // pure, so this costs nothing and cannot fail.
  const risk = assessListing({
    address, perPerson, photoUrl, contactEmail, contactPhone, notes,
    contactName, description: notes,
  });

  // Founder-created listings are curated by definition and publish directly.
  // Everything else waits for a human — including a clean score, because a
  // clean score is not evidence the poster controls the unit, which is the one
  // thing no classifier can check. When posting opens up, this line is what
  // keeps "no fake listings" true.
  const status = risk.recommendation === 'reject' ? 'rejected' : 'approved';

  try {
    const { rows } = await pool.query(
      `INSERT INTO listings
         (address, city, school_near, beds, baths,
          total_rent_cents, per_person_rent_cents, photo_url,
          contact_name, contact_email, contact_phone, available_from, notes, created_by,
          moderation_status, risk_score, risk_signals)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17)
       RETURNING id, address, city, school_near, beds,
                 per_person_rent_cents, created_by`,
      [
        address,
        city ?? null,
        schoolNear,
        beds,
        baths,
        Math.round(Number(totalRent) * 100),
        Math.round(Number(perPerson) * 100),
        photoUrl ?? null,
        contactName ?? null,
        contactEmail ?? null,
        contactPhone ?? null,
        availableFrom ?? null,
        notes ?? null,
        req.user.id,
        status,
        risk.score,
        JSON.stringify(risk.signals),
      ],
    );
    // Tell the poster what the scorer saw. A founder adding a listing that
    // trips signals should know immediately, not discover it in a queue.
    res.json({ id: rows[0].id, moderationStatus: status, riskScore: risk.score, signals: risk.signals });

    // Fan out to anyone watching for a place like this. DETACHED on purpose:
    // the listing is already created and the response already sent, so a dead
    // Resend key or a stale push token can never fail a listing insert.
    // Only announce what a student is actually allowed to see. Emailing an
    // alert about a listing the feed hides would be worse than not alerting.
    if (status === 'approved') {
      notifyNewListing(rows[0], req.app.get('sendPushToUser'))
        .catch(err => console.error('[listingAlerts] fan-out failed:', err.message));
    }

    // Geocode, also detached. A third-party lookup must never sit between a
    // founder pressing save and the listing existing — and a listing with no
    // coordinates degrades to the address text search, which is exactly the
    // behaviour that shipped before this column existed.
    geocodeListing({ address, city, schoolNear })
      .then(async (coords) => {
        await pool.query(
          `UPDATE listings
              SET latitude = $2, longitude = $3, geocoded_at = now()
            WHERE id = $1`,
          [rows[0].id, coords?.lat ?? null, coords?.lon ?? null],
        );
      })
      .catch(err => console.error('[geocode] failed:', err.message));
  } catch (err) {
    console.error('listing create failed:', err);
    res.status(500).json({ error: 'Failed to create listing' });
  }
});

// —— GET /housing/alert ————————————————————————————————————————————
// The caller's listing alert, or null. One per user by design (see the
// listing_alerts migration for why).
router.get('/alert', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT school_near, max_per_person_cents, min_beds, is_active, last_notified_at
         FROM listing_alerts WHERE user_id = $1`,
      [req.user.id],
    );
    if (!rows[0]) return res.json({ alert: null });
    const a = rows[0];
    res.json({
      alert: {
        schoolNear:   a.school_near,
        // Cents in the column, dollars on the wire — the app talks in dollars
        // everywhere else, and a unit mismatch here would silently alert on a
        // budget 100x too high.
        maxPerPerson: a.max_per_person_cents == null ? null : Math.round(a.max_per_person_cents / 100),
        minBeds:      a.min_beds,
        isActive:     a.is_active,
        lastNotifiedAt: a.last_notified_at,
      },
    });
  } catch (err) {
    console.error('alert fetch failed:', err);
    res.status(500).json({ error: 'Failed to load alert' });
  }
});

// —— PUT /housing/alert ————————————————————————————————————————————
// Upsert. schoolNear is required; maxPerPerson / minBeds are optional and null
// means "no opinion" rather than "match nothing".
router.put('/alert', requireAuth, async (req, res) => {
  const { schoolNear, maxPerPerson, minBeds, isActive } = req.body || {};

  if (!schoolNear || typeof schoolNear !== 'string' || schoolNear.length > 200) {
    return res.status(400).json({ error: 'schoolNear is required' });
  }
  const budget = maxPerPerson == null ? null : Number(maxPerPerson);
  if (budget !== null && (!Number.isFinite(budget) || budget <= 0 || budget > 100000)) {
    return res.status(400).json({ error: 'maxPerPerson must be a positive dollar amount' });
  }
  const beds = minBeds == null ? null : Number(minBeds);
  if (beds !== null && (!Number.isInteger(beds) || beds < 1 || beds > 10)) {
    return res.status(400).json({ error: 'minBeds must be between 1 and 10' });
  }

  try {
    await pool.query(
      `INSERT INTO listing_alerts
         (user_id, school_near, max_per_person_cents, min_beds, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id) DO UPDATE SET
         school_near          = EXCLUDED.school_near,
         max_per_person_cents = EXCLUDED.max_per_person_cents,
         min_beds             = EXCLUDED.min_beds,
         is_active            = EXCLUDED.is_active,
         updated_at           = now()`,
      [
        req.user.id,
        schoolNear,
        budget === null ? null : Math.round(budget * 100),
        beds,
        isActive === false ? false : true,
      ],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('alert save failed:', err);
    res.status(500).json({ error: 'Failed to save alert' });
  }
});

// —— DELETE /housing/alert —————————————————————————————————————————
// Deactivates rather than deletes, so turning it back on keeps the criteria
// the student already chose instead of making them re-enter everything.
router.delete('/alert', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE listing_alerts SET is_active = FALSE, updated_at = now() WHERE user_id = $1',
      [req.user.id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('alert delete failed:', err);
    res.status(500).json({ error: 'Failed to turn off alert' });
  }
});

// ── DELETE /housing/listings/:id ──────────────────────────────────────────
// Soft delete — flips is_active false. Keeps the audit trail intact.
router.delete('/listings/:id', requireAuth, async (req, res) => {
  if (!isFounder(req.user.id)) {
    return res.status(403).json({ error: 'Founder-only' });
  }
  try {
    await pool.query('UPDATE listings SET is_active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('listing delete failed:', err);
    res.status(500).json({ error: 'Failed to delete listing' });
  }
});

// ── GET /housing/timing?school=&domain=&area=&metro= ─────────────────────────
// "Best time to lock in" for a student's area, from PUBLIC Zillow Research ZORI
// rent data (no scraping). Resolution priority: metro (explicit override) →
// area (typed locality) → domain/name → school ZIP/city/county, resolved to a
// CBSA by authoritative Census membership with a state sanity gate. It NEVER
// snaps to the nearest big metro: if it isn't confident, it 404s (the app then
// degrades to honest reasoned guidance) — a wrong metro is worse than no data.
// City-level ZORI is returned when held (areaLevel:'city'); else the metro
// roll-up (areaLevel:'metro'). Public (no auth): aggregate stats only, no PII.
router.get('/timing', async (req, res) => {
  try {
    const q = (k) => (typeof req.query[k] === 'string' ? req.query[k].trim() : '');
    const metro = q('metro'), school = q('school'), domain = q('domain'), area = q('area');
    if (!metro && !school && !domain && !area) {
      return res.status(400).json({ error: 'metro, school, domain, or area query param required' });
    }

    const r = ht.resolveHousing({ metro, area, domain, school });
    if (!r) return res.status(404).json({ error: 'no housing-timing data for that area' });

    // Precedence: ZORI city (seasonal) → ZORI metro (seasonal) → HUD county
    // (annual LEVEL) → 404. Each tier carries its own confidence + honesty flags.
    if (r.zori && r.zori.city) {
      const cityRow = await ht.getTimingByKey(`city:${ht.normalizeRegionKey(r.zori.city)}`);
      if (cityRow && cityRow.timing) {
        return res.json({ metro: r.zori.cbsaFull, city: r.zori.city, areaLevel: 'city',
                          confidence: 'high', ...cityRow.timing });
      }
    }
    if (r.zori) {
      const metroRow = await ht.getTimingByKey(ht.normalizeRegionKey(r.zori.short));
      if (metroRow && metroRow.timing) {
        return res.json({ metro: r.zori.cbsaFull, areaLevel: 'metro',
                          confidence: 'medium', ...metroRow.timing });
      }
    }
    // HUD county-level fallback — an annual LEVEL, never seasonal. Assemble
    // explicitly so no seasonal field can leak: no months, hasSeasonal:false,
    // typicalRent set, and the HUD source label carried verbatim.
    if (r.fips) {
      const countyRow = await ht.getTimingByKey(`county:${r.fips}`);
      if (countyRow && countyRow.timing) {
        const t = countyRow.timing;
        return res.json({
          metro: countyRow.region_name, areaLevel: 'county', confidence: 'low',
          hasSeasonal: false, typicalRent: t.typicalRent, bestMonthsToSearch: [],
          asOf: t.asOf, source: t.source,
        });
      }
    }
    return res.status(404).json({ error: 'no housing-timing data for that area' });
  } catch (err) {
    console.error('[housing/timing] failed:', err);
    res.status(500).json({ error: 'housing timing lookup failed' });
  }
});

// ── GET /housing/review (founder-only) ───────────────────────────────────────
// The crosswalk review queue: NEW / renamed / low-confidence-fuzzy school→metro
// matches held for a human instead of auto-shipped. Empty in the healthy case
// (the app's schools are 100% exact .edu-domain matches). Founder-gated because
// it exposes the maintenance backlog, not student-facing data.
router.get('/review', requireAuth, async (req, res) => {
  if (!isFounder(req.user.id)) return res.status(403).json({ error: 'Founder-only' });
  try {
    res.json({ pending: await ht.listCrosswalkReview('pending') });
  } catch (err) {
    console.error('[housing/review] failed:', err);
    res.status(500).json({ error: 'Failed to load review queue' });
  }
});

// ── POST /housing/ingest-timing (bot-gated) ──────────────────────────────────
// Manual trigger for the ZORI ingest + recompute. The weekly in-process job
// (server.js) is the primary mechanism; this is for on-demand backfills. Optional
// body { url } overrides the source CSV (if Zillow moves the path).
router.post('/ingest-timing', requireBotToken, async (req, res) => {
  try {
    const result = await ht.ingestZori({ url: typeof req.body?.url === 'string' ? req.body.url : undefined });
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    console.error('[housing ingest] failed:', err);
    res.status(500).json({ error: 'ingest failed' });
  }
});

module.exports = router;
