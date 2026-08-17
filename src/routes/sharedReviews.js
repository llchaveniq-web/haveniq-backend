// ─── Shared landlord + building reviews ───────────────────────────────────
//
// User-submitted reviews of landlords and apartment buildings, visible to
// everyone in the network. Distinct from the user-to-user roommate
// reviews (see routes/reviews.js — different table, different shape).
//
// Tables landlord_reviews_shared + building_reviews_shared were added in
// the 2026-05-22 migration. This file exposes them via two routers.
//
// This is the highest-exposure UGC in the app — public, network-wide, and
// names a real third party who never agreed to be reviewed. It used to be
// publish-and-forget: BLOCK-tier content was screened out at post time, but
// there was no per-landlord/building dedup (one account could post the same
// review dozens of times), no way for the author to edit or retract their
// own review, and no moderation path at all — the `hidden` column existed
// in the schema and was filtered on read, but nothing ever set it. Fixed
// below: FLAG-tier content (scam signals) now queues for review instead of
// being silently ignored; a reviewer can't double-post about the same
// landlord/building; the author can edit or delete their own review; and a
// moderator can hide one that slips through (or that a landlord disputes
// through support).

const pool = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const { writeReview } = require('../middleware/rateLimits');
const { screenMessage } = require('../lib/contentFilter');
const { isModeratorUser } = require('../utils/founders');
const { audit } = require('../services/auditLog');

function requireModerator(req, res, next) {
  if (!isModeratorUser(req.user)) {
    return res.status(403).json({ error: 'Moderator access required.' });
  }
  next();
}

const REVIEW_BLOCKED = {
  code:  'content_blocked',
  error: "This review can't be posted — it looks like it breaks our community guidelines. A negative review is fine, but keep it factual and respectful.",
};

// Self-healing columns (this repo's convention — see roommateSafety.js /
// stories.js). Guards a fresh DB / a deploy that hasn't run the migration
// yet from 500ing the first flagged post or the first admin-review call.
let columnsReady = false;
async function ensureModerationColumns() {
  if (columnsReady) return;
  await pool.query(`
    ALTER TABLE landlord_reviews_shared ADD COLUMN IF NOT EXISTS flagged_category TEXT;
    ALTER TABLE landlord_reviews_shared ADD COLUMN IF NOT EXISTS flagged_at       TIMESTAMPTZ;
    ALTER TABLE building_reviews_shared ADD COLUMN IF NOT EXISTS flagged_category TEXT;
    ALTER TABLE building_reviews_shared ADD COLUMN IF NOT EXISTS flagged_at       TIMESTAMPTZ;
  `).catch((e) => console.error('[shared-reviews] ensure moderation columns:', e.message));
  columnsReady = true;
}

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
    await ensureModerationColumns();

    // One review per (reviewer, landlord) — without this, a single account
    // could post the same review dozens of times to pile onto a rating.
    // Case-insensitive so "Acme Realty" and "acme realty" collide.
    const { rows: dupe } = await pool.query(
      `SELECT id FROM landlord_reviews_shared
        WHERE reviewer_id = $1 AND LOWER(landlord_name) = LOWER($2)
        LIMIT 1`,
      [req.user.id, landlordName.trim()],
    );
    if (dupe[0]) {
      return res.status(409).json({
        error: 'You already reviewed this landlord. Edit your existing review instead.',
        code: 'duplicate_review',
        existingReviewId: dupe[0].id,
      });
    }

    // Screen the free text (and the landlord name, which is displayed).
    // BLOCK refuses the post outright; FLAG (scam signals) still posts it
    // but queues it for moderator review — same two-tier handling
    // messages.js applies to DMs, previously missing here entirely.
    const screen = screenMessage(`${landlordName} ${reviewText}`);
    if (screen.action === 'block') {
      return res.status(422).json(REVIEW_BLOCKED);
    }

    const { rows } = await pool.query(
      `INSERT INTO landlord_reviews_shared
         (reviewer_id, landlord_name, rating_overall, rating_response,
          rating_maintenance, rating_fairness, review_text, is_anonymous,
          flagged_category, flagged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, landlord_name, rating_overall, rating_response,
                 rating_maintenance, rating_fairness, review_text,
                 is_anonymous, helpful_count, created_at`,
      [
        req.user.id, landlordName.trim(), ratingOverall,
        ratingResponse ?? null, ratingMaintenance ?? null,
        ratingFairness ?? null, reviewText.trim(), !!isAnonymous,
        screen.action === 'flag' ? screen.category : null,
        screen.action === 'flag' ? new Date() : null,
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

// PATCH /landlord-reviews/:id — author-only edit. Re-validates and
// re-screens exactly like a fresh POST (an edit is a new opportunity to
// slip abusive content in, so it gets the same gate, not a lighter one).
landlordRouter.patch('/:id', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { ratingOverall, ratingResponse, ratingMaintenance, ratingFairness, reviewText } = req.body || {};
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
    await ensureModerationColumns();
    const { rows: existing } = await pool.query(
      'SELECT landlord_name FROM landlord_reviews_shared WHERE id = $1 AND reviewer_id = $2',
      [req.params.id, req.user.id],
    );
    if (!existing[0]) return res.status(404).json({ error: 'Review not found' });

    const screen = screenMessage(`${existing[0].landlord_name} ${reviewText}`);
    if (screen.action === 'block') return res.status(422).json(REVIEW_BLOCKED);

    const { rows } = await pool.query(
      `UPDATE landlord_reviews_shared
          SET rating_overall = $1, rating_response = $2, rating_maintenance = $3,
              rating_fairness = $4, review_text = $5,
              flagged_category = $6, flagged_at = $7
        WHERE id = $8 AND reviewer_id = $9
        RETURNING id, landlord_name, rating_overall, rating_response,
                  rating_maintenance, rating_fairness, review_text,
                  is_anonymous, helpful_count, created_at`,
      [
        ratingOverall, ratingResponse ?? null, ratingMaintenance ?? null,
        ratingFairness ?? null, reviewText.trim(),
        screen.action === 'flag' ? screen.category : null,
        screen.action === 'flag' ? new Date() : null,
        req.params.id, req.user.id,
      ],
    );
    res.json({ review: rows[0] });
  } catch (err) {
    console.error('[landlord-reviews PATCH] failed:', err.message);
    res.status(500).json({ error: 'Could not update your review. Please try again.' });
  }
});

// DELETE /landlord-reviews/:id — author-only.
landlordRouter.delete('/:id', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM landlord_reviews_shared WHERE id = $1 AND reviewer_id = $2',
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Review not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[landlord-reviews DELETE] failed:', err.message);
    res.status(500).json({ error: 'Could not delete your review. Please try again.' });
  }
});

// GET /landlord-reviews/admin — moderator review queue. ?filter=flagged
// (default) shows only scam-flagged reviews; ?filter=all shows everything,
// hidden or not, at every school — this is the surface a landlord dispute
// filed through support ultimately gets acted on through.
landlordRouter.get('/admin', requireAuth, requireModerator, async (req, res) => {
  try {
    await ensureModerationColumns();
    const flaggedOnly = req.query.filter !== 'all';
    const { rows } = await pool.query(
      `SELECT r.id, r.landlord_name, r.rating_overall, r.review_text, r.is_anonymous,
              r.hidden, r.flagged_category, r.flagged_at, r.created_at,
              r.reviewer_id, u.first_name, u.email
         FROM landlord_reviews_shared r
         LEFT JOIN users u ON u.id = r.reviewer_id
         ${flaggedOnly ? 'WHERE r.flagged_category IS NOT NULL' : ''}
        ORDER BY r.created_at DESC
        LIMIT 200`,
    );
    res.json({ reviews: rows });
  } catch (err) {
    console.error('[landlord-reviews admin GET] failed:', err.message);
    res.status(500).json({ error: 'Could not load reviews.' });
  }
});

// PATCH /landlord-reviews/admin/:id — moderator hide/unhide. Body: { hidden }.
landlordRouter.patch('/admin/:id', requireAuth, requireModerator, async (req, res) => {
  try {
    const hidden = req.body?.hidden;
    if (typeof hidden !== 'boolean') return res.status(400).json({ error: 'hidden (boolean) is required' });
    const { rowCount } = await pool.query(
      'UPDATE landlord_reviews_shared SET hidden = $1 WHERE id = $2',
      [hidden, req.params.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Review not found' });
    audit(req, hidden ? 'landlordReview.hide' : 'landlordReview.unhide', { reviewId: req.params.id }).catch(() => {});
    res.json({ ok: true, hidden });
  } catch (err) {
    console.error('[landlord-reviews admin PATCH] failed:', err.message);
    res.status(500).json({ error: 'Could not update review.' });
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
    await ensureModerationColumns();

    // One review per (reviewer, building address) — same dedup rationale
    // as landlord reviews.
    const { rows: dupe } = await pool.query(
      `SELECT id FROM building_reviews_shared
        WHERE reviewer_id = $1 AND LOWER(building_address) = LOWER($2)
        LIMIT 1`,
      [req.user.id, buildingAddress.trim()],
    );
    if (dupe[0]) {
      return res.status(409).json({
        error: 'You already reviewed this building. Edit your existing review instead.',
        code: 'duplicate_review',
        existingReviewId: dupe[0].id,
      });
    }

    // Screen the free-text fields. BLOCK refuses; FLAG still posts but
    // queues for moderator review.
    const freeText = [pros, cons, tips].filter(t => typeof t === 'string' && t.trim()).join(' \n ');
    const screen = freeText ? screenMessage(freeText) : { action: 'allow', category: null };
    if (screen.action === 'block') {
      return res.status(422).json(REVIEW_BLOCKED);
    }

    const { rows } = await pool.query(
      `INSERT INTO building_reviews_shared
         (reviewer_id, building_address, move_in_date, move_out_date,
          rating_overall, rating_noise, rating_pest, rating_hvac,
          rating_management, recommend, pros, cons, tips,
          flagged_category, flagged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
        screen.action === 'flag' ? screen.category : null,
        screen.action === 'flag' ? new Date() : null,
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

// PATCH /building-reviews/:id — author-only edit.
buildingRouter.patch('/:id', requireAuth, refuseBanned, async (req, res) => {
  try {
    const {
      moveInDate, moveOutDate, ratingOverall, ratingNoise, ratingPest,
      ratingHvac, ratingManagement, recommend, pros, cons, tips,
    } = req.body || {};
    if (!Number.isInteger(ratingOverall) || ratingOverall < 1 || ratingOverall > 5) {
      return res.status(400).json({ error: 'ratingOverall must be an integer 1-5' });
    }
    const optionals = { ratingNoise, ratingPest, ratingHvac, ratingManagement };
    for (const [k, v] of Object.entries(optionals)) {
      if (v != null && (!Number.isInteger(v) || v < 1 || v > 5)) {
        return res.status(400).json({ error: `${k} must be an integer 1-5 or omitted` });
      }
    }
    await ensureModerationColumns();
    const { rows: existing } = await pool.query(
      'SELECT id FROM building_reviews_shared WHERE id = $1 AND reviewer_id = $2',
      [req.params.id, req.user.id],
    );
    if (!existing[0]) return res.status(404).json({ error: 'Review not found' });

    const freeText = [pros, cons, tips].filter(t => typeof t === 'string' && t.trim()).join(' \n ');
    const screen = freeText ? screenMessage(freeText) : { action: 'allow', category: null };
    if (screen.action === 'block') return res.status(422).json(REVIEW_BLOCKED);

    const { rows } = await pool.query(
      `UPDATE building_reviews_shared
          SET move_in_date = $1, move_out_date = $2, rating_overall = $3,
              rating_noise = $4, rating_pest = $5, rating_hvac = $6,
              rating_management = $7, recommend = $8, pros = $9, cons = $10, tips = $11,
              flagged_category = $12, flagged_at = $13
        WHERE id = $14 AND reviewer_id = $15
        RETURNING id, building_address, move_in_date, move_out_date,
                  rating_overall, rating_noise, rating_pest, rating_hvac,
                  rating_management, recommend, pros, cons, tips,
                  helpful_count, created_at`,
      [
        moveInDate || null, moveOutDate || null, ratingOverall,
        ratingNoise ?? null, ratingPest ?? null, ratingHvac ?? null, ratingManagement ?? null,
        recommend ?? null, pros?.trim() || null, cons?.trim() || null, tips?.trim() || null,
        screen.action === 'flag' ? screen.category : null,
        screen.action === 'flag' ? new Date() : null,
        req.params.id, req.user.id,
      ],
    );
    res.json({ review: rows[0] });
  } catch (err) {
    console.error('[building-reviews PATCH] failed:', err.message);
    res.status(500).json({ error: 'Could not update your review. Please try again.' });
  }
});

// DELETE /building-reviews/:id — author-only.
buildingRouter.delete('/:id', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM building_reviews_shared WHERE id = $1 AND reviewer_id = $2',
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Review not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[building-reviews DELETE] failed:', err.message);
    res.status(500).json({ error: 'Could not delete your review. Please try again.' });
  }
});

// GET /building-reviews/admin — moderator review queue.
buildingRouter.get('/admin', requireAuth, requireModerator, async (req, res) => {
  try {
    await ensureModerationColumns();
    const flaggedOnly = req.query.filter !== 'all';
    const { rows } = await pool.query(
      `SELECT r.id, r.building_address, r.rating_overall, r.pros, r.cons, r.tips,
              r.hidden, r.flagged_category, r.flagged_at, r.created_at,
              r.reviewer_id, u.first_name, u.email
         FROM building_reviews_shared r
         LEFT JOIN users u ON u.id = r.reviewer_id
         ${flaggedOnly ? 'WHERE r.flagged_category IS NOT NULL' : ''}
        ORDER BY r.created_at DESC
        LIMIT 200`,
    );
    res.json({ reviews: rows });
  } catch (err) {
    console.error('[building-reviews admin GET] failed:', err.message);
    res.status(500).json({ error: 'Could not load reviews.' });
  }
});

// PATCH /building-reviews/admin/:id — moderator hide/unhide. Body: { hidden }.
buildingRouter.patch('/admin/:id', requireAuth, requireModerator, async (req, res) => {
  try {
    const hidden = req.body?.hidden;
    if (typeof hidden !== 'boolean') return res.status(400).json({ error: 'hidden (boolean) is required' });
    const { rowCount } = await pool.query(
      'UPDATE building_reviews_shared SET hidden = $1 WHERE id = $2',
      [hidden, req.params.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Review not found' });
    audit(req, hidden ? 'buildingReview.hide' : 'buildingReview.unhide', { reviewId: req.params.id }).catch(() => {});
    res.json({ ok: true, hidden });
  } catch (err) {
    console.error('[building-reviews admin PATCH] failed:', err.message);
    res.status(500).json({ error: 'Could not update review.' });
  }
});

module.exports = { landlordRouter, buildingRouter };
