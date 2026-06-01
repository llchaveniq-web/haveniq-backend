/**
 * Match of the Day — the daily ritual feature.
 *
 * Each user gets ONE curated match per calendar day, selected from
 * their highest-compatibility unseen pool. Same person stays pinned
 * for the entire day (deterministic by date) so a user who opens the
 * app three times in the morning sees the same person all three
 * times — no "wait, where did Sarah go?" disorientation.
 *
 * After the day rolls over, a new person is selected and the previous
 * day's pick goes back into the regular matches feed (unless the user
 * already acted on it — sent a hi, saved, or dismissed).
 *
 * Brand: editorial. Like a magazine delivering one curated profile
 * each morning. NOT a swipe stack — three deliberate buttons:
 *   send_hi     → triggers a connect_request
 *   saved       → adds to saved list (future feature; logged today)
 *   not_for_me  → silently de-prioritizes this person in future feeds
 *
 * Strategic value:
 *   - Daily reason to open the app (variable reward — different person each day)
 *   - Push-notification-worthy event ("Your match for today is here")
 *   - Lower cognitive load than a 20-person match list
 *   - Generates per-day action signal we can use to tune scoring
 */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const ALLOWED_ACTIONS = new Set(['pending', 'sent_hi', 'saved', 'not_for_me']);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_of_the_day (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shown_date     DATE NOT NULL,
      match_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action         TEXT NOT NULL DEFAULT 'pending',
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      acted_at       TIMESTAMPTZ,
      UNIQUE(user_id, shown_date)
    );
    CREATE INDEX IF NOT EXISTS idx_motd_user_date
      ON match_of_the_day(user_id, shown_date DESC);
    CREATE INDEX IF NOT EXISTS idx_motd_action
      ON match_of_the_day(user_id, action)
      WHERE action != 'pending';
  `).catch((e) => console.error('[match_of_the_day] ensure table:', e.message));
}

/**
 * Resolve "today" in the user's timezone — for now we use server UTC
 * which is fine for a Pacific-Time MVP (the rollover happens at 5pm
 * Pacific, which is when most students are checking their phones
 * anyway). If we ever go national, we'll need to read user.timezone.
 */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pick the user's top unseen compatible person.
 *
 * "Unseen" excludes:
 *   - Anyone they've already been shown as a previous Match of the Day
 *   - Anyone with an existing connect_request (either direction)
 *   - Anyone they've blocked or who has blocked them
 *   - Anyone with action != 'pending' on a prior day's pick
 *
 * Order: highest compatibility score descending, with a small random
 * tiebreaker so ties don't produce the same person every day.
 */
async function pickTodayMatch(userId) {
  const { rows } = await pool.query(
    `SELECT
       u.id            AS match_user_id,
       cs.score
     FROM compatibility_scores cs
     JOIN users u ON (
       CASE WHEN cs.user_a = $1 THEN cs.user_b ELSE cs.user_a END = u.id
     )
     WHERE (cs.user_a = $1 OR cs.user_b = $1)
       AND cs.is_hard_blocked = FALSE
       AND cs.score >= 70
       AND u.is_paused = FALSE
       AND u.is_banned = FALSE
       AND u.quiz_completed = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM match_of_the_day prev
         WHERE prev.user_id = $1 AND prev.match_user_id = u.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM connect_requests cr
         WHERE (cr.from_user = $1 AND cr.to_user   = u.id)
            OR (cr.to_user   = $1 AND cr.from_user = u.id)
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks ub
         WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
            OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
       )
     ORDER BY cs.score DESC, RANDOM()
     LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * Hydrate a match_of_the_day row into the full payload the frontend
 * needs (photo, name, school, compat breakdown, why_matched).
 */
async function hydrateMatch(userId, matchUserId, action) {
  const { rows } = await pool.query(
    `SELECT
       u.id, u.first_name, u.last_name, u.school, u.school_year, u.major,
       u.bio, u.photo_url, u.is_verified,
       cs.score, cs.breakdown, cs.why_matched
     FROM users u
     JOIN compatibility_scores cs
       ON (LEAST($1::uuid, u.id) = cs.user_a AND GREATEST($1::uuid, u.id) = cs.user_b)
     WHERE u.id = $2
     LIMIT 1`,
    [userId, matchUserId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    userId:       r.id,
    firstName:    r.first_name,
    lastInitial:  r.last_name ? r.last_name[0] : '',
    school:       r.school,
    schoolYear:   r.school_year,
    major:        r.major,
    bio:          r.bio,
    photoUrl:     r.photo_url,
    isVerified:   !!r.is_verified,
    score:        r.score != null ? Math.round(Number(r.score)) : null,
    breakdown:    r.breakdown || {},
    whyMatched:   r.why_matched || null,
    action:       action,
  };
}

// ── GET /matches/today ─────────────────────────────────────────────────
// Returns today's curated match for the authenticated user. Idempotent
// within a single calendar day — multiple calls return the same person.
// If no eligible match exists yet (new user, no scores, depleted pool),
// returns { match: null, reason: '...' } with a 200.
router.get('/today', requireAuth, async (req, res) => {
  await ensureTable();
  const userId = req.user.id;
  const today  = todayISO();

  try {
    // 1. Check if we already picked someone for today
    const existing = await pool.query(
      `SELECT match_user_id, action FROM match_of_the_day
       WHERE user_id = $1 AND shown_date = $2`,
      [userId, today],
    );
    let matchUserId, action;
    if (existing.rows[0]) {
      matchUserId = existing.rows[0].match_user_id;
      action      = existing.rows[0].action;
    } else {
      // 2. No pick yet — find the top compatible unseen person
      const pick = await pickTodayMatch(userId);
      if (!pick) {
        return res.json({
          match: null,
          reason: 'No eligible matches in your pool today. Check back tomorrow as new students join.',
        });
      }
      matchUserId = pick.match_user_id;
      action      = 'pending';
      // 3. Lock it in — UNIQUE(user_id, shown_date) prevents races
      await pool.query(
        `INSERT INTO match_of_the_day (user_id, shown_date, match_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, shown_date) DO NOTHING`,
        [userId, today, matchUserId],
      );
    }

    // 4. Hydrate with full profile + compat breakdown
    const match = await hydrateMatch(userId, matchUserId, action);
    if (!match) {
      // The matched user may have been deleted/banned/paused since we
      // recorded the pick. Surface gracefully.
      return res.json({
        match: null,
        reason: 'Today\'s match is temporarily unavailable. Try again in a few minutes.',
      });
    }

    res.json({ match });
  } catch (err) {
    console.error('[match-of-the-day] /today failed:', err);
    res.status(500).json({ error: 'Could not load today\'s match' });
  }
});

// ── POST /matches/today/action ─────────────────────────────────────────
// Record the user's action on today's match. Three actions:
//   send_hi     → also creates a connect_request to start a conversation
//   saved       → adds to their saved list (silent)
//   not_for_me  → silent dismissal (de-prioritizes in future feeds)
//
// Idempotent — repeated calls with the same action are a no-op.
// Changing action (e.g. saved → sent_hi) is allowed.
router.post('/today/action', requireAuth, async (req, res) => {
  await ensureTable();
  const userId = req.user.id;
  const { action } = req.body || {};
  if (!ALLOWED_ACTIONS.has(action) || action === 'pending') {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const today = todayISO();

  try {
    const { rows } = await pool.query(
      `SELECT match_user_id, action FROM match_of_the_day
       WHERE user_id = $1 AND shown_date = $2`,
      [userId, today],
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'No match of the day to act on' });
    }
    const matchUserId = rows[0].match_user_id;

    // Update the action + timestamp
    await pool.query(
      `UPDATE match_of_the_day
         SET action = $1, acted_at = NOW()
       WHERE user_id = $2 AND shown_date = $3`,
      [action, userId, today],
    );

    // For send_hi, also create the connect_request that powers the
    // existing messages/match-detail UI. Idempotent via UNIQUE on
    // (from_user, to_user).
    if (action === 'sent_hi') {
      await pool.query(
        `INSERT INTO connect_requests (from_user, to_user, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (from_user, to_user) DO NOTHING`,
        [userId, matchUserId],
      );
    }

    res.json({ ok: true, action });
  } catch (err) {
    console.error('[match-of-the-day] /today/action failed:', err);
    res.status(500).json({ error: 'Could not record action' });
  }
});

module.exports = router;
