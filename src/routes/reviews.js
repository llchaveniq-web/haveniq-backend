// ─── Roommate reviews (user-to-user) ───────────────────────────────────────
//
// Public UGC about a NAMED real student — the most sensitive text surface in
// the app. Distinct from the shared landlord/building reviews (see
// routes/sharedReviews.js — different tables, different subject: a business,
// not a person).
//
// This used to have none of the hardening its landlord-review sibling
// already has: no relationship gate at all (any authenticated account could
// post a permanent review about any other user's UUID, including a total
// stranger), FLAG-tier content (scam signals) silently dropped instead of
// queued, no moderator hide, and no author retract. `hidden` wasn't even in
// the schema. Fixed below, mirroring sharedReviews.js's already-hardened
// pattern: a relationship gate (areConnected — the same "real prior match"
// bar votes.js/matchOutcomes.js/userPhotos.js already use), a moderator
// queue + hide/unhide, and author delete. The existing create-or-overwrite
// upsert (ON CONFLICT on reviewer_id/reviewee_id) already serves as the
// author's edit path, so it's kept as-is rather than adding a redundant
// PATCH — but it deliberately does NOT touch `hidden`, so an edit can't
// silently un-hide something a moderator hid for a reason.
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
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
  error: "This review can't be posted — it looks like it breaks our community guidelines. A critical review is fine, but keep it respectful.",
};

// Self-healing columns (this repo's convention — see roommateSafety.js /
// sharedReviews.js). Guards a fresh DB / a deploy that hasn't run the
// migration yet from 500ing the first flagged post or the first admin call.
let columnsReady = false;
async function ensureModerationColumns() {
  if (columnsReady) return;
  await pool.query(`
    ALTER TABLE roommate_reviews ADD COLUMN IF NOT EXISTS hidden           BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE roommate_reviews ADD COLUMN IF NOT EXISTS flagged_category TEXT;
    ALTER TABLE roommate_reviews ADD COLUMN IF NOT EXISTS flagged_at       TIMESTAMPTZ;
  `).catch((e) => console.error('[reviews] ensure moderation columns:', e.message));
  columnsReady = true;
}

// Two users are "connected" when an accepted connect_request exists in
// EITHER direction — the same relationship votes.js's, matchOutcomes.js's,
// and userPhotos.js's areConnected() treat as a real match. Without this, a
// review was postable about ANY user id an account could obtain — a real
// harassment vector against a real, named student.
async function areConnected(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM connect_requests
      WHERE status = 'accepted'
        AND ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
      LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
}

// ── POST /reviews ─────────────────────────────────────────────────────────
// Submit (or update) a roommate review for another user. The UNIQUE
// constraint on (reviewer_id, reviewee_id) means each user can post one
// review per other user — re-submitting overwrites the prior one via
// ON CONFLICT.
//
// Body: {
//   revieweeId:    string (uuid),
//   overallRating: 1-5,
//   cleanliness:   1-5,
//   communication: 1-5,
//   respect:       1-5,
//   noiseLevel:    1-5,
//   body:          string (>=20 chars)
// }
router.post('/', requireAuth, refuseBanned, async (req, res) => {
  try {
    const {
      revieweeId, overallRating, cleanliness,
      communication, respect, noiseLevel, body,
    } = req.body;

    if (!revieweeId) {
      return res.status(400).json({ error: 'revieweeId required' });
    }
    if (revieweeId === req.user.id) {
      return res.status(400).json({ error: 'Cannot review yourself' });
    }
    const scores = { overallRating, cleanliness, communication, respect, noiseLevel };
    for (const [k, v] of Object.entries(scores)) {
      if (!Number.isInteger(v) || v < 1 || v > 5) {
        return res.status(400).json({ error: `${k} must be an integer 1-5` });
      }
    }
    if (typeof body !== 'string' || body.trim().length < 20) {
      return res.status(400).json({ error: 'body must be at least 20 characters' });
    }
    // Upper cap to match other user-generated content. 5K chars ≈ 1000
    // words — far more than any reasonable roommate review.
    if (body.length > 5000) {
      return res.status(400).json({ error: 'body exceeds 5000 character limit' });
    }
    if (!(await areConnected(req.user.id, revieweeId))) {
      return res.status(403).json({ error: 'You can only review someone you\'ve actually matched with.' });
    }
    await ensureModerationColumns();

    // A review is public UGC about a NAMED person — the most sensitive text in
    // the app. Screen it like every other UGC surface (messages, agreements) so
    // harassment/slurs can't be published as a "review". A critical review is
    // fine; an abusive one is not. FLAG-tier (scam signals) still posts, but
    // queues for moderator review — was previously silently dropped entirely.
    const screen = screenMessage(body);
    if (screen.action === 'block') {
      return res.status(422).json(REVIEW_BLOCKED);
    }

    const { rows } = await pool.query(
      `INSERT INTO roommate_reviews
         (reviewer_id, reviewee_id, overall_rating, cleanliness,
          communication, respect, noise_level, body, flagged_category, flagged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (reviewer_id, reviewee_id) DO UPDATE SET
         overall_rating   = EXCLUDED.overall_rating,
         cleanliness      = EXCLUDED.cleanliness,
         communication    = EXCLUDED.communication,
         respect          = EXCLUDED.respect,
         noise_level      = EXCLUDED.noise_level,
         body             = EXCLUDED.body,
         flagged_category = EXCLUDED.flagged_category,
         flagged_at       = EXCLUDED.flagged_at,
         created_at       = NOW()
       RETURNING id, created_at`,
      [
        req.user.id, revieweeId, overallRating, cleanliness,
        communication, respect, noiseLevel, body.trim(),
        screen.action === 'flag' ? screen.category : null,
        screen.action === 'flag' ? new Date() : null,
      ],
    );

    res.json({ id: rows[0].id, createdAt: rows[0].created_at });
  } catch (err) {
    console.error('review submit failed:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// ── DELETE /reviews/:id ────────────────────────────────────────────────────
// Author-only retract. Previously had no way to remove a review at all —
// once posted, an honest reviewer who wanted to take it back was stuck.
router.delete('/:id', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM roommate_reviews WHERE id = $1 AND reviewer_id = $2',
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Review not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('review delete failed:', err);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// ── GET /reviews/user/:id ─────────────────────────────────────────────────
// Public reviews for a given user. Reviewer identity is intentionally
// omitted — reviews are surfaced as anonymous to encourage honesty.
router.get('/user/:id', requireAuth, async (req, res) => {
  try {
    await ensureModerationColumns();
    const { rows } = await pool.query(
      `SELECT id, overall_rating, cleanliness, communication, respect,
              noise_level, body, helpful_count, created_at
       FROM roommate_reviews
       WHERE reviewee_id = $1 AND hidden = FALSE
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    console.error('review list failed:', err);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// ── GET /reviews/admin ─────────────────────────────────────────────────────
// Moderator queue: flagged-and-unreviewed content plus a way to browse
// everything hidden or not. Previously there was NO way to ever see this
// table's content except a direct DB query — reviews.js had no admin
// surface at all, unlike every other UGC route in this codebase.
// ?filter=flagged|hidden|all (default 'flagged').
router.get('/admin', requireAuth, requireModerator, async (req, res) => {
  try {
    await ensureModerationColumns();
    const filter = String(req.query.filter || 'flagged');
    const where = filter === 'hidden' ? 'WHERE hidden = TRUE'
      : filter === 'all' ? ''
      : 'WHERE flagged_category IS NOT NULL';
    const { rows } = await pool.query(
      `SELECT id, reviewer_id, reviewee_id, overall_rating, cleanliness,
              communication, respect, noise_level, body, hidden,
              flagged_category, flagged_at, created_at
         FROM roommate_reviews
         ${where}
         ORDER BY created_at DESC
         LIMIT 200`,
    );
    res.json({ reviews: rows });
  } catch (err) {
    console.error('review admin list failed:', err);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// ── PATCH /reviews/admin/:id ──────────────────────────────────────────────
// Moderator hide/unhide. Body: { hidden }.
router.patch('/admin/:id', requireAuth, requireModerator, async (req, res) => {
  try {
    const hidden = req.body?.hidden;
    if (typeof hidden !== 'boolean') return res.status(400).json({ error: 'hidden (boolean) is required' });
    await ensureModerationColumns();
    const { rowCount } = await pool.query(
      'UPDATE roommate_reviews SET hidden = $1 WHERE id = $2',
      [hidden, req.params.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Review not found' });
    audit(req, hidden ? 'roommateReview.hide' : 'roommateReview.unhide', { reviewId: req.params.id }).catch(() => {});
    res.json({ ok: true, hidden });
  } catch (err) {
    console.error('review admin hide failed:', err);
    res.status(500).json({ error: 'Failed to update review' });
  }
});

module.exports = router;
