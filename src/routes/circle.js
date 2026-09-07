const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// Overall % → tier. MUST match the frontend (haveniq-app utils/fitTier.ts: 90/80/70/60).
function tierFor(pct) {
  if (pct >= 90) return 'exceptional';
  if (pct >= 80) return 'strong';
  if (pct >= 70) return 'good';
  if (pct >= 60) return 'moderate';
  return 'low';
}

// GET /circle/me — people connected to me via a referral, in EITHER direction
// (people I invited, and whoever invited me), + my compatibility to each.
//
// Was one-sided: only WHERE r.referrer_id = $1 (people I invited). A invited
// B is already a real, mutual, known fact the moment it happens — B just had
// no way to see A in THEIR circle. That's not a missing feature, it's an
// asymmetric view of data that already exists, so no new consent/backend
// work is needed to fix it, just a symmetric read.
//
// Can't just add "OR r.referred_id = $1" to the WHERE clause below — the JOIN
// target flips depending on direction (when I'm the referrer, show the
// referred person's info; when I'm the referred, show the referrer's info).
// Needs a UNION ALL of the two directions instead.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    const { rows } = await pool.query(
      // Schema reality: referrals.referrer_id / referred_id are TEXT (they hold
      // uuid-format strings), while users.id and compatibility_scores.user_a/_b
      // are UUID. So the same id has to be compared as TEXT against referrals
      // and as UUID against compatibility_scores. We pass it as two positional
      // params to keep each one single-typed and avoid Postgres's "inconsistent
      // types deduced for parameter" error:
      //   $1 (TEXT)      → referrals.referrer_id / referred_id (matches
      //                     u.id::text join, the same cast growthDigest.js /
      //                     lifecycleSegments.js use)
      //   $2::uuid       → compatibility_scores.user_a/_b via LEAST/GREATEST
      // Comparing UUID = TEXT directly ("u.id = r.referred_id" / bare "$1::uuid"
      // reused against a TEXT column) throws and would 500 every request.
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.photo_url,
              u.school_year, u.quiz_completed, cs.score AS score,
              r.created_at, 'invited' AS direction
         FROM referrals r
         JOIN users u ON u.id::text = r.referred_id
         LEFT JOIN compatibility_scores cs
           ON cs.user_a = LEAST(u.id, $2::uuid)
          AND cs.user_b = GREATEST(u.id, $2::uuid)
        WHERE r.referrer_id = $1

        UNION ALL

       SELECT u.id AS user_id, u.first_name, u.last_name, u.photo_url,
              u.school_year, u.quiz_completed, cs.score AS score,
              r.created_at, 'was_invited_by' AS direction
         FROM referrals r
         JOIN users u ON u.id::text = r.referrer_id
         LEFT JOIN compatibility_scores cs
           ON cs.user_a = LEAST(u.id, $2::uuid)
          AND cs.user_b = GREATEST(u.id, $2::uuid)
        WHERE r.referred_id = $1

        ORDER BY created_at DESC`,
      [uid, uid],
    );
    const members = rows.map((r) => {
      let score = null;
      if (r.quiz_completed === true && r.score != null) {
        const finalPct = Math.round(parseFloat(r.score));
        score = { finalPct, tier: tierFor(finalPct) };
      }
      return {
        userId:       r.user_id,
        firstName:    r.first_name || '',
        lastInitial:  (r.last_name || '').trim().charAt(0).toUpperCase() || '',
        photoUrl:     r.photo_url || null,
        schoolYear:   r.school_year || undefined,
        quizComplete: r.quiz_completed === true,
        score,
        direction:    r.direction,
      };
    });
    res.json({ ok: true, members });
  } catch (e) {
    console.error('[circle/me]', e.message);
    res.status(500).json({ ok: false, members: [] });
  }
});

module.exports = router;
