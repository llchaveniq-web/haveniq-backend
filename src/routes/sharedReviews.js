// ─── Shared landlord + building reviews ───────────────────────────────────
//
// User-submitted reviews of landlords and apartment buildings, visible to
// everyone in the network. Distinct from the user-to-user roommate
// reviews (see routes/reviews.js — different table, different shape).
//
// Tables landlord_reviews_shared + building_reviews_shared were added in
// the 2026-05-22 migration. This file exposes them via two routers.

const pool = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const { writeReview } = require('../middleware/rateLimits');
const { screenMessage } = require('../lib/contentFilter');

// These reviews are network-wide public and name a real landlord / building —
// the highest-exposure UGC in the app. Screen their free text like every other
// UGC surface so harassment or a defamatory rant can't be published. A negative
// review is fine; an abusive one is refused.
const REVIEW_BLOCKED = {
  code:  'content_blocked',
  error: "This review can't be posted — it looks like it breaks our community guidelines. A negative review is fine, but keep it factual and respectful.",
};

// ── Landlord reviews ──────────────────────────────────────────────────────
const landlordRouter = require('express').Router();

// POST /landlord-reviews
// Body: { landlordName, ratingOverall, ratingResponse?, ratingMaintenance?,
//         ratingFairness?, reviewText, isAnonymous? }
landlordRouter.post('/', requireAuth, refuseBanned, writeReview, async (req, res) => {
  try {
    const {
      landlordName, ratingOverall, ratingResponse, ratingMaintenance,
      ratingFairness, reviewText, isAnonymous = true,
    } = req.body || {};

    // Required fields. Numeric ratings must be 1-5; optional ones may be
    // null. Free text must be at least 10 chars — same minimum the UI
    // tells users to write.
    if (!landlordName || typeof landlordName !== 'string') {
      return res.status(400).json({ error: 'landlordName is required' });
    }
    if (!Number.isInteger(ratingOverall) || ratingOverall < 1 || ratingOverall > 5) {
      return res.status(400).json({ error: 'ratingOverall must be an integer 1-5' });
    }
    if (typeof reviewText !== 'string' || reviewText.trim().length < 10) {
      return res.status(400).json({ error: 'reviewText must be at least 10 characters' });
    }
    const optionals = { ratingResponse, ratingMaintenance, ratingFairness };
    for (const [k, v] of Object.entries(optionals)) {
      if (v != null && (!Number.isInteger(v) || v < 1 || v > 5)) {
        return res.status(400).json({ error: `${k} must be an integer 1-5 or omitted` });
      }
    }
    // Screen the free text (and the landlord name, which is displayed) so an
    // abusive or defamatory review can't be published network-wide.
    if (screenMessage(`${landlordName} ${reviewText}`).action === 'block') {
      return res.status(422).json(REVIEW_BLOCKED);
    }

    const { rows } = await pool.query(
      `INSERT INTO landlord_reviews_shared
         (reviewer_id, landlord_name, rating_overall, rating_response,
          rating_maintenance, rating_fairness, review_text, is_anonymous)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, landlord_name, rating_overall, rating_response,
                 rating_maintenance, rating_fairness, review_text,
                 is_anonymous, helpful_count, created_at`,
      [
        req.user.id, landlordName.trim(), ratingOverall,
        ratingResponse ?? null, ratingMaintenance ?? null,
        ratingFairness ?? null, reviewText.trim(), !!isAnonymous,
      ],
    );
    res.status(201).json({ review: rows[0] });
  } catch (err) {
    console.error('[landlord-reviews POST] failed:', err.message);
    res.status(500).json({ error: 'Could not save your review. Please try again.' });
  }
});

// GET /landlord-reviews/search?q=...&limit=20
// Case-insensitive prefix match on landlord_name. Returns most recent
// non-hidden reviews. Empty q returns the global recent feed.
landlordRouter.get('/search', requireAuth, async (req, res) => {
  try {
    const q     = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const params = [];
    let where = 'WHERE hidden = FALSE';
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where += ` AND LOWER(landlord_name) LIKE $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, landlord_name, rating_overall, rating_response,
              rating_maintenance, rating_fairness, review_text,
              is_anonymous, helpful_count, created_at
         FROM landlord_reviews_shared
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
      params,
    );
    res.json({ reviews: rows });
  } catch (err) {
    console.error('[landlord-reviews GET] failed:', err.message);
    res.status(500).json({ error: 'Could not load reviews.' });
  }
});

// ── Building reviews ──────────────────────────────────────────────────────
const buildingRouter = require('express').Router();

// POST /building-reviews
// Body: { buildingAddress, moveInDate?, moveOutDate?, ratingOverall,
//         ratingNoise?, ratingPest?, ratingHvac?, ratingManagement?,
//         recommend?, pros?, cons?, tips? }
buildingRouter.post('/', requireAuth, refuseBanned, writeReview, async (req, res) => {
  try {
    const {
      buildingAddress, moveInDate, moveOutDate, ratingOverall,
      ratingNoise, ratingPest, ratingHvac, ratingManagement,
      recommend, pros, cons, tips,
    } = req.body || {};

    if (!buildingAddress || typeof buildingAddress !== 'string') {
      return res.status(400).json({ error: 'buildingAddress is required' });
    }
    if (!Number.isInteger(ratingOverall) || ratingOverall < 1 || ratingOverall > 5) {
      return res.status(400).json({ error: 'ratingOverall must be an integer 1-5' });
    }
    const optionals = { ratingNoise, ratingPest, ratingHvac, ratingManagement };
    for (const [k, v] of Object.entries(optionals)) {
      if (v != null && (!Number.isInteger(v) || v < 1 || v > 5)) {
        return res.status(400).json({ error: `${k} must be an integer 1-5 or omitted` });
      }
    }
    // Screen the free-text fields so an abusive review can't be published.
    const freeText = [pros, cons, tips].filter(t => typeof t === 'string' && t.trim()).join(' \n ');
    if (freeText && screenMessage(freeText).action === 'block') {
      return res.status(422).json(REVIEW_BLOCKED);
    }

    const { rows } = await pool.query(
      `INSERT INTO building_reviews_shared
         (reviewer_id, building_address, move_in_date, move_out_date,
          rating_overall, rating_noise, rating_pest, rating_hvac,
          rating_management, recommend, pros, cons, tips)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, building_address, move_in_date, move_out_date,
                 rating_overall, rating_noise, rating_pest, rating_hvac,
                 rating_management, recommend, pros, cons, tips,
                 helpful_count, created_at`,
      [
        req.user.id, buildingAddress.trim(),
        moveInDate || null, moveOutDate || null,
        ratingOverall, ratingNoise ?? null, ratingPest ?? null,
        ratingHvac ?? null, ratingManagement ?? null,
        recommend ?? null,
        pros?.trim() || null, cons?.trim() || null, tips?.trim() || null,
      ],
    );
    res.status(201).json({ review: rows[0] });
  } catch (err) {
    console.error('[building-reviews POST] failed:', err.message);
    res.status(500).json({ error: 'Could not save your review. Please try again.' });
  }
});

// GET /building-reviews/search?q=...&limit=20
buildingRouter.get('/search', requireAuth, async (req, res) => {
  try {
    const q     = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const params = [];
    let where = 'WHERE hidden = FALSE';
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where += ` AND LOWER(building_address) LIKE $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, building_address, move_in_date, move_out_date,
              rating_overall, rating_noise, rating_pest, rating_hvac,
              rating_management, recommend, pros, cons, tips,
              helpful_count, created_at
         FROM building_reviews_shared
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
      params,
    );
    res.json({ reviews: rows });
  } catch (err) {
    console.error('[building-reviews GET] failed:', err.message);
    res.status(500).json({ error: 'Could not load reviews.' });
  }
});

module.exports = { landlordRouter, buildingRouter };
