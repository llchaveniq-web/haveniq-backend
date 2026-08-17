const router = require('express').Router();
const pool   = require('../db/pool');
const { galleryJoin, photosFor } = require('../lib/photoGallery');
const { requireAuth } = require('../middleware/auth');
const { isFounder }   = require('../utils/founders');
const { notDemo }     = require('../lib/demoFilter');
const { search: searchLimiter } = require('../middleware/rateLimits');

// ── GET /search?q=... ─────────────────────────────────────────────────────
// Single-bar search across:
//   1. Users at the caller's school (first name / last name fuzzy match)
//   2. Groups the caller is a member of (name match)
// Capped at 8 results per bucket. Demo accounts hidden unless caller is a
// founder. Paused users excluded. is_banned excluded — this is a separate
// query path from matches.js's feed queries, and it had drifted from
// every other discovery surface in the app (matches.js, quiz.js,
// activityPulse.js, profile.js, users.js all filter is_banned); a banned
// account stayed fully searchable by name/photo/school, the one place
// "banned = invisible" didn't actually hold.
//
// Uses pg_trgm's similarity operator for typo-tolerant matching; that
// extension is created in migrate_missing.sql so it's already on prod.
router.get('/', requireAuth, searchLimiter, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ users: [], groups: [] });

  try {
    const { rows: userRows } = await pool.query('SELECT school FROM users WHERE id = $1', [req.user.id]);
    const callerSchool = userRows[0]?.school ?? null;
    // Demos surface in search only when DEMO_FEED=true (investor pitches).
    // By default the founder searches the real student pool like anyone else.
    const includeDemos = isFounder(req.user.id) && process.env.DEMO_FEED === 'true';
    const demoFilter   = includeDemos ? '' : `AND ${notDemo('u.email')}`;

    // ILIKE wins on prefix matches ("Jac" → "Jackson") and pg_trgm
    // covers fat-finger typos. We OR them and rank by trigram similarity
    // so prefix matches still float to the top.
    const { rows: users } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.school, u.photo_url,
              ph.urls AS photo_urls,
              GREATEST(similarity(u.first_name, $1), similarity(COALESCE(u.last_name,''), $1)) AS sim
       FROM users u
       ${galleryJoin('u.id', 'ph')}
       WHERE u.id != $2
         AND u.is_paused = FALSE
         AND COALESCE(u.is_banned, FALSE) = FALSE
         AND ($3::text IS NULL OR u.school = $3)
         AND (
           u.first_name ILIKE $4 OR u.last_name ILIKE $4
           OR similarity(u.first_name, $1) > 0.3
           OR similarity(COALESCE(u.last_name,''), $1) > 0.3
         )
         ${demoFilter}
       ORDER BY sim DESC NULLS LAST
       LIMIT 8`,
      [q, req.user.id, callerSchool, `${q}%`],
    );

    const { rows: groups } = await pool.query(
      `SELECT g.id, g.name, g.size_target, g.status,
              (SELECT COUNT(*)::int FROM match_group_members WHERE group_id = g.id) AS member_count
       FROM match_groups g
       JOIN match_group_members m ON m.group_id = g.id
       WHERE m.user_id = $1
         AND g.status != 'archived'
         AND g.name ILIKE $2
       ORDER BY g.created_at DESC
       LIMIT 8`,
      [req.user.id, `%${q}%`],
    );

    res.json({
      users: users.map(u => ({
        id:          u.id,
        firstName:   u.first_name,
        lastInitial: (u.last_name || '').slice(0, 1).toUpperCase(),
        school:      u.school,
        photoUrl:    u.photo_url,
        photos:      photosFor(u),
      })),
      groups,
    });
  } catch (err) {
    console.error('search failed:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
