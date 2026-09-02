/**
 * GET /connections — every connect request touching me, from MY side.
 *
 * The app has shipped a ConnectionsAPI since PR #17 that this backend never
 * answered: /connections returned 404 on every load of the Circle screen, and
 * the "Connect" item in a chat's menu always failed with "That connection
 * request failed to go through. Try again in a moment." — copy that tells a
 * student it is temporary when it could never work.
 *
 * ── Why this is one route and not four ──────────────────────────────────────
 *
 * Sending and responding ALREADY exist, fully gated, as POST /matches/connect
 * and POST /matches/respond: compatibility threshold, hard-block flag,
 * two-way user_blocks check, viability re-check, ban/pause. Building parallel
 * /connections/request and /connections/:id/accept endpoints would mean either
 * duplicating all of that or, far worse, forgetting a piece of it — a second
 * door into the same table with weaker locks. The app now calls the existing
 * endpoints for those two verbs.
 *
 * What genuinely did not exist is the LIST. /matches/requests answers a
 * narrower question — pending requests sent TO me — which is what the matches
 * screen needs. Circle needs the whole graph from the caller's perspective:
 * what I sent and am waiting on, what is waiting on me, what is confirmed, and
 * what was declined. Same `connect_requests` table, different question.
 *
 * No new table, no new write path.
 */

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /connections ───────────────────────────────────────────────────────
// -> { ok, connections: ConnectionListItem[] } — the shape types/index.ts in
// the app already declares, so nothing client-side has to be reshaped.
router.get('/', requireAuth, async (req, res) => {
  try {
    const me = req.user.id;
    const { rows } = await pool.query(
      `SELECT cr.id,
              cr.status              AS raw_status,
              cr.from_user,
              cr.to_user,
              cr.created_at,
              cr.updated_at,
              -- The other party, whichever side of the row I am on.
              u.id                   AS other_id,
              u.first_name,
              u.last_name,
              u.school,
              u.photo_url,
              u.quiz_completed,
              cs.score
         FROM connect_requests cr
         JOIN users u
           ON u.id = CASE WHEN cr.from_user = $1 THEN cr.to_user ELSE cr.from_user END
         LEFT JOIN compatibility_scores cs
           ON (cs.user_a = $1 AND cs.user_b = u.id)
           OR (cs.user_b = $1 AND cs.user_a = u.id)
         -- Someone who blocked me, or whom I blocked, is not in my graph.
         WHERE (cr.from_user = $1 OR cr.to_user = $1)
           AND u.is_banned = FALSE
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
           )
         ORDER BY cr.created_at DESC`,
      [me],
    );

    const connections = rows.map(r => ({
      id:     r.id,
      userId: r.other_id,
      firstName:   r.first_name || '',
      // Last INITIAL only — the app never shows a full surname before a match,
      // and sending one would leak more than the UI can use.
      lastInitial: (r.last_name || '').trim().charAt(0) || '',
      photoUrl:    r.photo_url ?? null,
      schoolYear:  r.school ?? undefined,
      quizComplete: !!r.quiz_completed,
      score: r.score == null ? undefined : { finalPct: Math.round(Number(r.score)) },
      // 'pending' means nothing on its own — it depends which end you are.
      status:
        r.raw_status === 'accepted' ? 'confirmed'
        : r.raw_status === 'declined' ? 'declined'
        : r.from_user === me ? 'pending_outbound'
        : 'pending_inbound',
      createdAt:   r.created_at,
      confirmedAt: r.raw_status === 'accepted' ? r.updated_at : null,
    }));

    res.json({ ok: true, connections });
  } catch (err) {
    console.error('[connections] list failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

module.exports = router;
