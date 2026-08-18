const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { isFounder }   = require('../utils/founders');
const { quickAction } = require('../middleware/rateLimits');

// ─── Partner offers — resource lead-gen ──────────────────────────────────
//
// The "Perks" surface: sponsored offers around being a student renter
// (furniture, insurance, moving help, etc.). The revenue model is the
// Angie's-list one Dave described — a partner is charged per qualified
// lead, and `click_count` is that billable lead metric.
//
// This ships the *mechanism*. Actual revenue needs real partner deals
// signed; until then the offers list is simply empty and the Perks
// screen shows a "coming soon" state.

// ── GET /offers ──────────────────────────────────────────────────────────
// Active partner offers for the student-facing Perks screen.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, blurb, category, sponsor_name, cta_label, cta_url
         FROM partner_offers
        WHERE is_active = TRUE
        ORDER BY created_at DESC`,
    );
    res.json({ offers: rows });
  } catch (err) {
    console.error('[offers] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load offers' });
  }
});

// ── POST /offers/:id/click ───────────────────────────────────────────────
// Records a click and returns the destination URL. The incremented
// click_count is the billable pay-per-lead figure for that partner, so it
// gets the same per-user/IP rate limit as other low-cost writes (60/hour) —
// without it, a scripted loop could inflate what a partner gets billed for.
router.post('/:id/click', requireAuth, quickAction, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE partner_offers
          SET click_count = click_count + 1
        WHERE id = $1 AND is_active = TRUE
        RETURNING cta_url`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Offer not found' });
    res.json({ url: rows[0].cta_url });
  } catch (err) {
    console.error('[offers] click failed:', err.message);
    res.status(500).json({ error: 'Failed to record click' });
  }
});

// ── POST /offers ─────────────────────────────────────────────────────────
// Founder-only: add a partner offer. (A founder dashboard UI can come
// later; for now offers are seeded through this endpoint.)
router.post('/', requireAuth, async (req, res) => {
  if (!isFounder(req.user.id)) {
    return res.status(403).json({ error: 'Founders only' });
  }
  try {
    const { title, blurb, category, sponsorName, ctaLabel, ctaUrl } = req.body || {};
    if (!title || !ctaUrl) {
      return res.status(400).json({ error: 'title and ctaUrl are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO partner_offers
         (title, blurb, category, sponsor_name, cta_label, cta_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        String(title).slice(0, 200),
        blurb ? String(blurb).slice(0, 500) : null,
        category ? String(category).slice(0, 60) : null,
        sponsorName ? String(sponsorName).slice(0, 120) : null,
        ctaLabel ? String(ctaLabel).slice(0, 60) : 'Learn more',
        String(ctaUrl).slice(0, 500),
      ],
    );
    res.json({ id: rows[0].id });
  } catch (err) {
    console.error('[offers] create failed:', err.message);
    res.status(500).json({ error: 'Failed to create offer' });
  }
});

// ── DELETE /offers/:id ───────────────────────────────────────────────────
// Founder-only: deactivate an offer (soft delete — keeps click history).
router.delete('/:id', requireAuth, async (req, res) => {
  if (!isFounder(req.user.id)) {
    return res.status(403).json({ error: 'Founders only' });
  }
  try {
    await pool.query(
      'UPDATE partner_offers SET is_active = FALSE WHERE id = $1',
      [req.params.id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[offers] delete failed:', err.message);
    res.status(500).json({ error: 'Failed to remove offer' });
  }
});

module.exports = router;
