const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { isFounder }   = require('../utils/founders');
const ht = require('../services/housingTiming');

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

    const { rows } = await pool.query(
      `SELECT id, address, city, school_near, beds, baths,
              total_rent_cents, per_person_rent_cents, photo_url,
              contact_name, available_from, notes, created_at
       FROM listings
       WHERE is_active = TRUE
         AND ($1::text IS NULL OR school_near = $1)
         AND ($2::integer IS NULL OR per_person_rent_cents <= $2)
         AND ($3::integer IS NULL OR beds >= $3)
       ORDER BY created_at DESC
       LIMIT 50`,
      [callerSchool, maxPerPerson, minBeds],
    );

    res.json({
      listings: rows.map(r => ({
        id:           r.id,
        address:      r.address,
        city:         r.city,
        schoolNear:   r.school_near,
        beds:         r.beds,
        baths:        Number(r.baths),
        totalRent:    r.total_rent_cents / 100,
        perPerson:    r.per_person_rent_cents / 100,
        photoUrl:     r.photo_url,
        contactName:  r.contact_name,
        availableFrom: r.available_from,
        notes:        r.notes,
        createdAt:    r.created_at,
      })),
    });
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
              total_rent_cents, per_person_rent_cents, photo_url,
              contact_name, contact_email, available_from, notes, created_at
       FROM listings
       WHERE id = $1 AND is_active = TRUE`,
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
      baths:         Number(r.baths),
      totalRent:     r.total_rent_cents / 100,
      perPerson:     r.per_person_rent_cents / 100,
      photoUrl:      r.photo_url,
      contactName:   r.contact_name,
      contactEmail:  r.contact_email,
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
    totalRent, perPerson, photoUrl, contactName, contactEmail,
    availableFrom, notes,
  } = req.body || {};

  if (!address || !schoolNear || !beds || !baths || !totalRent || !perPerson) {
    return res.status(400).json({ error: 'address, schoolNear, beds, baths, totalRent, perPerson are required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO listings
         (address, city, school_near, beds, baths,
          total_rent_cents, per_person_rent_cents, photo_url,
          contact_name, contact_email, available_from, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
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
        availableFrom ?? null,
        notes ?? null,
        req.user.id,
      ],
    );
    res.json({ id: rows[0].id });
  } catch (err) {
    console.error('listing create failed:', err);
    res.status(500).json({ error: 'Failed to create listing' });
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
