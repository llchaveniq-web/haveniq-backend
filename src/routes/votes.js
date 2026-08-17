const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { submitNomination, quickAction } = require('../middleware/rateLimits');
const { screenMessage } = require('../lib/contentFilter');

// ═══════════════════════════════════════════════════════════════════════
// Best Roommate Award — vote tallies for the /best-roommate screen.
// Each user can vote once per nominee (UNIQUE constraint enforces it
// at the DB level). Returns aggregated counts per nominee.
//
// POST /vote used to have NO check that the voter and nominee had ever
// interacted — any authenticated user could vote for an arbitrary user id,
// which directly inflates a real, publicly-displayed leaderboard
// (GET /nominees, sorted by vote_count). Same bug class as the fix
// applied to matchOutcomes.js's self-report gate — now requires a real
// accepted connect_request between the two users first.
// ═══════════════════════════════════════════════════════════════════════

// Two users are "connected" when an accepted connect_request exists in
// EITHER direction — same relationship userPhotos.js's and
// matchOutcomes.js's areConnected() treat as a real match.
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

// ── GET /best-roommate/nominees ──────────────────────────────────────────
// Returns current month's top nominees at the caller's school with
// real vote counts. Empty until students start voting.
router.get('/nominees', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.school, u.photo_url,
              COUNT(v.id)::int AS vote_count,
              EXISTS(
                SELECT 1 FROM best_roommate_votes v2
                WHERE v2.nominee_id = u.id AND v2.voter_id = $1
              ) AS i_voted
       FROM users u
       JOIN best_roommate_votes v ON v.nominee_id = u.id
       WHERE v.voter_school = $2
         AND v.created_at > NOW() - INTERVAL '30 days'
         AND u.is_paused = FALSE
       GROUP BY u.id
       ORDER BY vote_count DESC
       LIMIT 20`,
      [req.user.id, req.user.school],
    );

    res.json(rows.map(r => ({
      id:          r.id,
      firstName:   r.first_name ?? '',
      lastInitial: (r.last_name || '').charAt(0),
      school:      r.school,
      photoUrl:    r.photo_url,
      voteCount:   r.vote_count,
      iVoted:      r.i_voted,
    })));
  } catch (err) {
    console.error('nominees lookup failed:', err);
    res.status(500).json({ error: 'Failed to load nominees' });
  }
});

// ── POST /best-roommate/vote ─────────────────────────────────────────────
// Body: { nomineeId, reason? }
// UNIQUE (voter, nominee) means re-voting is a no-op (rejected at DB level).
router.post('/vote', requireAuth, quickAction, async (req, res) => {
  try {
    const { nomineeId, reason } = req.body || {};
    if (!nomineeId) return res.status(400).json({ error: 'nomineeId required' });
    if (nomineeId === req.user.id) {
      return res.status(400).json({ error: "You can't vote for yourself" });
    }

    // Verify the nominee exists and isn't paused
    const { rows: nominee } = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND is_paused = FALSE`,
      [nomineeId],
    );
    if (!nominee[0]) return res.status(404).json({ error: 'Nominee not found' });

    if (!(await areConnected(req.user.id, nomineeId))) {
      return res.status(403).json({ error: "You haven't matched with this person" });
    }

    await pool.query(
      `INSERT INTO best_roommate_votes (voter_id, nominee_id, voter_school, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (voter_id, nominee_id) DO NOTHING`,
      [req.user.id, nomineeId, req.user.school, reason ? String(reason).slice(0, 500) : null],
    );

    res.json({ recorded: true });
  } catch (err) {
    console.error('vote failed:', err);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

// ── POST /best-roommate/nominate ────────────────────────────────────────
// Body: { nomineeName, whyBest, specificStory?, qualities?, relationship? }
//
// The "I want to write a glowing nomination of my roommate" flow on the
// Best Roommate screen. Distinct from /vote (which records a count against
// an existing user). Nominations are free-text testimonials — they go to
// a separate table and don't yet contribute to vote_count.
router.post('/nominate', requireAuth, submitNomination, async (req, res) => {
  try {
    const { nomineeName, whyBest, specificStory, qualities, relationship } = req.body || {};
    if (!nomineeName || typeof nomineeName !== 'string') {
      return res.status(400).json({ error: 'nomineeName is required' });
    }
    if (typeof whyBest !== 'string' || whyBest.trim().length < 50) {
      return res.status(400).json({ error: 'whyBest must be at least 50 characters' });
    }
    const qArr = Array.isArray(qualities)    ? qualities.filter(s => typeof s === 'string').slice(0, 20) : [];
    const rArr = Array.isArray(relationship) ? relationship.filter(s => typeof s === 'string').slice(0, 10) : [];

    // This free text doesn't surface anywhere yet (no read path exists for
    // best_roommate_nominations today — see the file header), but it's
    // stored, and it will need this the moment a "nominations" feed ships.
    // Screening now instead of when that feed gets built means there's no
    // backlog of unscreened rows to retroactively deal with later.
    const screenText = `${nomineeName} ${whyBest} ${specificStory || ''}`;
    if (screenMessage(screenText).action === 'block') {
      return res.status(422).json({
        code: 'content_blocked',
        error: "This nomination can't be saved — it looks like it breaks our community guidelines.",
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO best_roommate_nominations
         (nominator_id, nominee_name, why_best, specific_story, qualities, relationship)
       VALUES ($1, $2, $3, $4, $5::TEXT[], $6::TEXT[])
       RETURNING id, nominee_name, created_at`,
      [
        req.user.id, nomineeName.trim(), whyBest.trim(),
        specificStory?.trim() || null, qArr, rArr,
      ],
    );
    res.status(201).json({ nomination: rows[0] });
  } catch (err) {
    console.error('nomination failed:', err);
    res.status(500).json({ error: 'Failed to save nomination' });
  }
});

module.exports = router;
