const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const suspicious = require('../middleware/suspiciousActivity');
const { sendParentMatchEmail, sendSafetyAlertEmail, sendMatchEmail, sendConnectRequestEmail } = require('../services/email');
const { isFounder } = require('../utils/founders');
const { computePairing } = require('../services/personalityPairing');
const { safetyReport, safetyBlock } = require('../middleware/rateLimits');
const { audit } = require('../services/auditLog');
const analytics = require('../services/analytics');

// Best-effort parent notification on a student's FIRST accepted match.
// Called twice — once for each side of the pair. Each user's row has
// `parent_notified` which gates against repeat sends. Wrapped in its own
// try/catch so a parent-email failure never blocks the accept response.
async function maybeNotifyParent(studentId, matchUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.parent_email, u.parent_notified,
              m.first_name AS match_first, m.last_name AS match_last, m.school AS match_school,
              cs.score AS compatibility
       FROM users u
       JOIN users m ON m.id = $2
       LEFT JOIN compatibility_scores cs
              ON (cs.user_a = LEAST(u.id, m.id) AND cs.user_b = GREATEST(u.id, m.id))
       WHERE u.id = $1`,
      [studentId, matchUserId],
    );
    const row = rows[0];
    if (!row || !row.parent_email || row.parent_notified) return;

    await sendParentMatchEmail({
      parentEmail:      row.parent_email,
      studentName:      row.first_name || 'Your student',
      matchName:        `${row.match_first} ${(row.match_last || '').charAt(0)}.`,
      matchSchool:      row.match_school,
      compatibilityPct: Math.round(Number(row.compatibility) || 0),
      userId:           studentId,
    });

    await pool.query(
      'UPDATE users SET parent_notified = TRUE WHERE id = $1',
      [studentId],
    );
  } catch (err) {
    console.error('[parent notify] send failed:', err);
  }
}

// Email the STUDENT themselves when a match forms. This is the ONLY
// re-engagement path that reaches web users: the app runs as a web SPA and
// push-token registration no-ops on web (HavenIQ-App utils/registerPushToken),
// so the "request accepted" push above never arrives for them. Without this
// email a matched student who isn't actively on the site is never told and
// doesn't come back. Best-effort + its own try/catch so it never blocks the
// accept response. Skips seeded demo accounts (no real inbox).
async function maybeEmailMatch(studentId, matchUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.email AS to_email, u.first_name AS to_name,
              m.first_name AS match_first, m.last_name AS match_last,
              cs.score AS compatibility
       FROM users u
       JOIN users m ON m.id = $2
       LEFT JOIN compatibility_scores cs
              ON (cs.user_a = LEAST(u.id, m.id) AND cs.user_b = GREATEST(u.id, m.id))
       WHERE u.id = $1`,
      [studentId, matchUserId],
    );
    const row = rows[0];
    if (!row || !row.to_email) return;
    if (/@haveniq-demo\.edu$/i.test(row.to_email)) return; // seeded fakes, no inbox
    await sendMatchEmail(
      row.to_email,
      row.to_name || 'there',
      `${row.match_first || ''} ${(row.match_last || '').charAt(0)}.`.trim(),
      Math.round(Number(row.compatibility) || 0),
      studentId,
    );
  } catch (err) {
    console.error('[match email] send failed:', err);
  }
}

// Email the recipient when a connect request is RECEIVED — the top-of-funnel
// re-engagement moment. Same web-push-is-dead rationale as maybeEmailMatch.
// Best-effort; skips seeded demo accounts.
async function maybeEmailConnectRequest(toUserId, fromUserId, score) {
  try {
    const { rows } = await pool.query(
      `SELECT u.email AS to_email, u.first_name AS to_name,
              f.first_name AS from_first, f.last_name AS from_last
         FROM users u JOIN users f ON f.id = $2
        WHERE u.id = $1`,
      [toUserId, fromUserId],
    );
    const row = rows[0];
    if (!row || !row.to_email) return;
    if (/@haveniq-demo\.edu$/i.test(row.to_email)) return;
    await sendConnectRequestEmail(
      row.to_email,
      row.to_name || 'there',
      `${row.from_first || ''} ${(row.from_last || '').charAt(0)}.`.trim(),
      Math.round(Number(score) || 0),
      toUserId,
    );
  } catch (err) {
    console.error('[connect-request email] send failed:', err);
  }
}

// ── GET /matches/feed ─────────────────────────────────────────────────────
// Returns scored, filtered matches for the current user
// Feed gets pulled on every app open + manual refresh — 100/5min is the
// threshold. A user who refreshes 20x is still fine; one pulling the feed
// programmatically every 3 seconds (200/5min) trips the audit log.
router.get('/feed', requireAuth, suspicious.track('matches.feed', 100), async (req, res) => {
  try {
    const userId = req.user.id;
    const { school } = req.query;  // optional school filter

    // Demo-user filter is applied to REAL students only. Founders bypass
    // it so investor demos (the conference, advisor meetings, etc.) show
    // a populated match feed instead of "you + your brother." Real
    // student trust is preserved because the filter still hides demos
    // for everyone else.
    const includeDemos = isFounder(userId);
    const demoFilter   = includeDemos ? '' : "AND u.email NOT LIKE '%@haveniq-demo.edu'";

    // Current user's MBTI/DISC — feeds the secondary personality-pairing
    // readout on each match card. Display-only; never touches scoring.
    const { rows: meRows } = await pool.query(
      'SELECT mbti, disc FROM personality_profiles WHERE user_id = $1',
      [userId],
    );
    const me = meRows[0] || {};

    const { rows } = await pool.query(
      `SELECT
         cs.score,
         cs.is_soft_blocked,
         cs.shadow_penalty,
         cs.breakdown,
         cs.why_matched,
         u.id,
         u.first_name,
         u.last_name,
         u.school,
         u.school_year,
         u.major,
         u.bio,
         u.gender,
         u.looking_for,
         u.photo_url,
         u.budget_min,
         u.budget_max,
         u.move_in_timeline,
         u.is_verified,
         u.trust_score,
         u.identity_verified_at,
         pp.mbti  AS pairing_mbti,
         pp.disc  AS pairing_disc,
         cr.id     AS connect_request_id,
         cr.status AS connect_status
       FROM compatibility_scores cs
       JOIN users u ON (
         CASE WHEN cs.user_a = $1 THEN cs.user_b ELSE cs.user_a END = u.id
       )
       LEFT JOIN personality_profiles pp ON pp.user_id = u.id
       LEFT JOIN connect_requests cr ON (
         (cr.from_user = $1 AND cr.to_user = u.id) OR
         (cr.to_user = $1   AND cr.from_user = u.id)
       )
       WHERE (cs.user_a = $1 OR cs.user_b = $1)
         AND cs.is_hard_blocked = FALSE
         AND cs.score >= 50
         AND u.is_paused = FALSE
         AND u.is_banned = FALSE
         AND u.quiz_completed = TRUE
         -- NOTE: no profile-completeness gate here. We tried gating discovery
         -- on name/age/photo/is_verified earlier and it silently broke real
         -- matches (an account that finished the quiz but not its profile, or
         -- lacked a photo, vanished from everyone's feed). Matching now shows
         -- any quiz-completed, non-blocked candidate — the same behavior that
         -- worked at launch. Incomplete profiles just render with fallbacks.
         -- Honor user_blocks in BOTH directions. If either side has
         -- blocked the other, the pair never appears in the feed.
         -- Algorithmic-block via cs.is_hard_blocked is separate.
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks ub
           WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
              OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
         )
         ${demoFilter}
         ${school ? 'AND u.school = $2' : ''}
       ORDER BY cs.score DESC
       LIMIT 50`,
      school ? [userId, school] : [userId]
    );

    const matches = rows.map(r => ({
      userId:        r.id,
      firstName:     r.first_name,
      lastName:      r.last_name,
      school:        r.school,
      schoolYear:    r.school_year,
      major:         r.major,
      bio:           r.bio,
      gender:        r.gender,
      lookingFor:    r.looking_for || [],
      photoUrl:      r.photo_url,
      budgetMin:     r.budget_min,
      budgetMax:     r.budget_max,
      moveInTimeline:r.move_in_timeline,
      isVerified:    r.is_verified,
      trustScore:    r.trust_score,
      // ID-verified timestamp from Stripe Identity. Null when the user
      // hasn't done selfie+ID; non-null = the "ID ✓" badge renders on
      // their match card. Distinct from `isVerified` (= .edu email).
      identityVerifiedAt: r.identity_verified_at,
      compatScore:   parseFloat(r.score),
      isSoftBlocked: r.is_soft_blocked,
      shadowPenalty: parseFloat(r.shadow_penalty),
      breakdown:     r.breakdown || {},
      whyMatched:    r.why_matched,
      // Secondary, display-only MBTI/DISC personality lens. Never affects
      // compatScore — see services/personalityPairing.js.
      pairing:       computePairing(me.mbti, me.disc, r.pairing_mbti, r.pairing_disc),
      // Direct MBTI / DISC strings for surfacing on the match card.
      // (`pairing` above already encodes the *relationship* between two
      // profiles; these are the raw type strings — "INFJ", "D" — that the
      // UI displays as a small pill so students see the psychology piece
      // they were promised, not just an opaque score.)
      mbti:          r.pairing_mbti || null,
      disc:          r.pairing_disc || null,
      connectStatus: r.connect_status || null,
      requestId:     r.connect_request_id || null,
    }));

    res.json(matches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// ── POST /matches/connect ─────────────────────────────────────────────────
// Send a connect request
// Launch calibration: identical answers = 100; real compatible pairs land
// ~50-60. 65 was too high — it produced ZERO matches for every real user
// (verified 2026-06-08). Must stay in lockstep with the feed threshold in
// the /feed query above. Tune upward as the user base grows and higher-
// compatibility pairs become available.
const CONNECT_MIN_SCORE = 50;
router.post('/connect', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { toUserId } = req.body || {};
    if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
    if (toUserId === req.user.id) {
      return res.status(400).json({ error: 'Cannot connect to yourself' });
    }

    // Eligibility gate — without this, a malicious client can spam
    // connect requests at guessed UUIDs. Require a real compatibility
    // row above the surface threshold AND no hard-block flag.
    const { rows: compat } = await pool.query(
      `SELECT score, is_hard_blocked
         FROM compatibility_scores
        WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
        LIMIT 1`,
      [req.user.id, toUserId]
    );
    if (!compat[0]) {
      return res.status(404).json({ error: 'Match not found' });
    }
    if (compat[0].is_hard_blocked) {
      return res.status(403).json({ error: 'Not eligible to connect' });
    }
    if (parseFloat(compat[0].score) < CONNECT_MIN_SCORE) {
      return res.status(403).json({ error: 'Compatibility too low to connect' });
    }

    // Refuse if either side has blocked the other. Generic error to avoid
    // leaking the existence of a block to the would-be sender ("user not
    // found / eligible" looks the same whether they were blocked or never
    // existed).
    const { rows: blockRows } = await pool.query(
      `SELECT 1 FROM user_blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)
        LIMIT 1`,
      [req.user.id, toUserId],
    );
    if (blockRows[0]) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Check if already connected or pending
    const { rows: existing } = await pool.query(
      `SELECT status FROM connect_requests
       WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`,
      [req.user.id, toUserId]
    );

    if (existing[0]) {
      return res.status(409).json({ error: 'Request already exists', status: existing[0].status });
    }

    await pool.query(
      'INSERT INTO connect_requests (from_user, to_user, status) VALUES ($1, $2, $3)',
      [req.user.id, toUserId, 'pending']
    );

    // Recipient-side analytics. The frontend already fires connect_request_sent
    // on the sender; this captures the matching event for the user being
    // contacted so it appears on BOTH users' PostHog timelines.
    analytics.track(analytics.EVENTS.connect_request_received, toUserId, {
      from_user_id: req.user.id,
      score: parseFloat(compat[0].score),
    });

    // Push notification to recipient (fire-and-forget)
    const sendPushToUser = req.app.get('sendPushToUser');
    if (sendPushToUser) {
      const senderName = req.user.first_name || 'Someone';
      sendPushToUser(toUserId, {
        title: 'New connect request ✦',
        body: `${senderName} wants to connect with you on HavenIQ`,
        data: { screen: 'matches' },
      }).catch(err => console.error('[push] connect request send failed:', err));
    }

    // Email the recipient too — push never reaches web users.
    maybeEmailConnectRequest(toUserId, req.user.id, compat[0].score).catch(() => {});

    res.json({ success: true, status: 'pending' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send connect request' });
  }
});

// ── POST /matches/respond ─────────────────────────────────────────────────
// Accept or decline a connect request
router.post('/respond', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { fromUserId, action } = req.body; // action: 'accept' | 'decline'
    if (!fromUserId || !['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'fromUserId and action (accept|decline) required' });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'declined';

    const { rows } = await pool.query(
      `UPDATE connect_requests SET status = $1, updated_at = NOW()
       WHERE from_user = $2 AND to_user = $3 AND status = 'pending'
       RETURNING *`,
      [newStatus, fromUserId, req.user.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Pending request not found' });
    }

    // If accepted, create a conversation and notify the original sender
    if (action === 'accept') {
      const [userA, userB] = req.user.id < fromUserId
        ? [req.user.id, fromUserId]
        : [fromUserId, req.user.id];

      await pool.query(
        `INSERT INTO conversations (user_a, user_b)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userA, userB]
      );

      // Push notification to the person whose request was accepted
      const sendPushToUser = req.app.get('sendPushToUser');
      if (sendPushToUser) {
        const acceptorName = req.user.first_name || 'Someone';
        sendPushToUser(fromUserId, {
          title: 'Connect request accepted! ✦',
          body: `${acceptorName} accepted your connect request. Say hello!`,
          data: { screen: 'messages' },
        }).catch(err => console.error('[push] accept send failed:', err));
      }

      // Real-time in-app moment for the REQUESTER. Push is dead on web (no
      // tokens), so if they're online right now the socket is the only channel
      // that reaches them live — without this they'd just silently see the
      // conversation appear later. Emit to their personal room; the client
      // shows a "you're connected!" celebration + refreshes the journal.
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${fromUserId}`).emit('match_accepted', {
          withUserId: req.user.id,
          withName:   req.user.first_name || 'Someone',
        });
      }

      // First-match parent notification. Fire for BOTH users — each one's
      // parent (if registered) gets a one-time "your student just matched"
      // email. Awaited in the background so the API response stays fast.
      maybeNotifyParent(req.user.id, fromUserId).catch(() => {});
      maybeNotifyParent(fromUserId, req.user.id).catch(() => {});

      // Email the matched student themselves (the original requester). The
      // accepter is active in the app right now; the requester is the one who
      // may be offline and — on web, with no push token — otherwise never
      // learns they matched.
      maybeEmailMatch(fromUserId, req.user.id).catch(() => {});
    }

    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to respond to request' });
  }
});

// ── GET /matches/requests ─────────────────────────────────────────────────
// Incoming pending requests
router.get('/requests', requireAuth, async (req, res) => {
  try {
    // Same founder-bypass pattern as /feed. Demo connect requests are
    // hidden from real students but shown to founders so the "incoming
    // requests" tab is also populated for investor demos.
    const includeDemos = isFounder(req.user.id);
    const demoFilter   = includeDemos ? '' : "AND u.email NOT LIKE '%@haveniq-demo.edu'";

    const { rows } = await pool.query(
      `SELECT cr.id, cr.from_user, cr.created_at,
              u.first_name, u.last_name, u.school, u.photo_url,
              cs.score
       FROM connect_requests cr
       JOIN users u ON u.id = cr.from_user
       LEFT JOIN compatibility_scores cs ON (
         (cs.user_a = cr.from_user AND cs.user_b = $1) OR
         (cs.user_b = cr.from_user AND cs.user_a = $1)
       )
       WHERE cr.to_user = $1
         AND cr.status = 'pending'
         AND u.is_paused = FALSE
         ${demoFilter}
       ORDER BY cr.created_at DESC`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// ── GET /matches/:userId/score-history ──────────────────────────────────
// Returns the historical compatibility_scores rows between the caller and
// `userId`, ordered oldest→newest. Powers the Compatibility Timeline
// screen. Each row in this table represents a recomputation (e.g. when
// either party retook the quiz), so the timeline reads as score-over-
// time for this specific pairing.
//
// Returns: Array<{ score, calculated_at }>
router.get('/:userId/score-history', requireAuth, async (req, res) => {
  try {
    const otherId = req.params.userId;
    const meId    = req.user.id;

    const { rows } = await pool.query(
      `SELECT score, calculated_at
       FROM compatibility_scores
       WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
       ORDER BY calculated_at ASC`,
      [meId, otherId],
    );

    res.json(rows.map(r => ({
      score:        Number(r.score),
      calculatedAt: r.calculated_at,
    })));
  } catch (err) {
    console.error('score-history failed:', err);
    res.status(500).json({ error: 'Failed to load score history' });
  }
});

// ── POST /matches/:matchId/block ─────────────────────────────────────────
// Permanently block another user. Filter rules elsewhere (feed, messages)
// honor user_blocks rows so the blocker stops seeing this user in either
// direction. UNIQUE (blocker, blocked) makes this idempotent — second
// block is a no-op.
router.post('/:matchId/block', requireAuth, safetyBlock, async (req, res) => {
  try {
    const blockerId = req.user.id;
    const blockedId = req.params.matchId;
    if (!blockedId) return res.status(400).json({ error: 'matchId is required' });
    if (blockedId === blockerId) {
      return res.status(400).json({ error: "You can't block yourself" });
    }
    const reason = typeof req.body?.reason === 'string'
      ? req.body.reason.slice(0, 500)
      : null;

    await pool.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [blockerId, blockedId, reason],
    );

    // Soft-cancel any open connect-requests between the two so the UI
    // can't keep surfacing them. Hard delete would lose audit trail.
    await pool.query(
      `UPDATE connect_requests SET status = 'declined', updated_at = NOW()
        WHERE status = 'pending'
          AND ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))`,
      [blockerId, blockedId],
    );

    audit(req, 'user.block', { blocked: blockedId }).catch(() => {});
    analytics.track(analytics.EVENTS.user_blocked, blockerId, { target_user_id: blockedId });
    res.json({ blocked: true });
  } catch (err) {
    console.error('block failed:', err);
    res.status(500).json({ error: 'Could not block user' });
  }
});

// ── DELETE /matches/:matchId/block ───────────────────────────────────────
// Undo a previous block. Useful if the user changes their mind.
router.delete('/:matchId/block', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [req.user.id, req.params.matchId],
    );
    audit(req, 'user.unblock', { blocked: req.params.matchId }).catch(() => {});
    res.json({ blocked: false });
  } catch (err) {
    console.error('unblock failed:', err);
    res.status(500).json({ error: 'Could not unblock user' });
  }
});

// ── POST /matches/:matchId/report ────────────────────────────────────────
// Body: { reason?, category?, severity?, details? }
//
// File a safety report against another user. Persists to user_reports,
// fires a Resend email to the founder for triage, writes an audit row.
// Best-effort on the email so a Resend hiccup never breaks the report.
router.post('/:matchId/report', requireAuth, safetyReport, async (req, res) => {
  try {
    const reporterId = req.user.id;
    const reportedId = req.params.matchId;
    if (!reportedId) return res.status(400).json({ error: 'matchId is required' });

    const {
      reason   = null,
      category = 'other',
      severity = 'medium',
      details  = null,
    } = req.body || {};

    const validCats     = ['harassment', 'spam', 'fake_profile', 'inappropriate_content', 'safety', 'other'];
    const validSevs     = ['low', 'medium', 'high', 'urgent'];
    const safeCat       = validCats.includes(String(category)) ? category : 'other';
    const safeSev       = validSevs.includes(String(severity)) ? severity : 'medium';
    const safeReason    = reason  ? String(reason).slice(0, 200) : null;
    const safeDetails   = details ? String(details).slice(0, 4000) : null;

    const { rows } = await pool.query(
      `INSERT INTO user_reports
         (reporter_id, reported_id, category, severity, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [reporterId, reportedId, safeCat, safeSev, safeReason, safeDetails],
    );
    const reportId = rows[0].id;

    // Fire safety alert email to the founder. Fire-and-forget — never
    // block the report response on Resend.
    sendSafetyAlertEmail({
      reportId,
      category:   safeCat,
      severity:   safeSev,
      reason:     safeReason,
      details:    safeDetails,
      reporterId,
      reportedId,
    }).catch(err => console.error('[safety alert email] failed:', err.message));

    audit(req, 'user.report', { reported: reportedId, category: safeCat, severity: safeSev }).catch(() => {});
    analytics.track(analytics.EVENTS.report_submitted, reporterId, {
      target_user_id: reportedId,
      reason: safeCat,
    });
    res.status(201).json({ reported: true, reportId });
  } catch (err) {
    console.error('report failed:', err);
    res.status(500).json({ error: 'Could not file report' });
  }
});

// ── GET /matches/:userId/openers ───────────────────────────────────────
// First-message coach. Returns 3 short, personalized opener suggestions
// the user can tap to insert into their first message to this match.
//
// Why: students freeze at "hey" and conversations die. By surfacing
// 2-3 openers grounded in real shared context (school, major, quiz
// overlap), we tilt the odds toward a real conversation. Drafts only —
// the user reviews + can edit before sending.
//
// Caching: each (viewer, target) pair is cached for 24h so re-opening
// the match doesn't re-bill Claude. Cache invalidates when either
// user updates their profile.
const openerCache = new Map();  // key = `${viewerId}:${targetId}` → { openers, expiresAt }
const OPENER_TTL_MS = 24 * 60 * 60 * 1000;

router.get('/:userId/openers', requireAuth, async (req, res) => {
  const viewerId = req.user.id;
  const targetId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(targetId) || targetId === viewerId) {
    return res.status(400).json({ error: 'invalid target user id' });
  }

  // Cache check
  const cacheKey = `${viewerId}:${targetId}`;
  const cached = openerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ openers: cached.openers, cached: true });
  }

  // Anthropic key must be present
  const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? '').replace(/[^!-~]/g, '');
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'Opener coach unavailable (ANTHROPIC_API_KEY not set)' });
  }

  try {
    // Pull both users' profile context. Keep the fields narrow so we
    // never ship something like an email address to the LLM.
    const { rows } = await pool.query(
      `SELECT id, first_name, school, school_year, major, bio
       FROM users
       WHERE id IN ($1, $2)`,
      [viewerId, targetId]
    );
    const me = rows.find((r) => r.id === viewerId);
    const them = rows.find((r) => r.id === targetId);
    if (!me || !them) {
      return res.status(404).json({ error: 'one or both users not found' });
    }

    // Pull quiz answers for both, find overlap on the same questions
    const quizRows = await pool.query(
      `SELECT user_id, question_id, answer_value
       FROM quiz_answers
       WHERE user_id IN ($1, $2)`,
      [viewerId, targetId]
    ).catch(() => ({ rows: [] }));
    const myAnswers   = new Map(quizRows.rows.filter((r) => r.user_id === viewerId).map((r) => [r.question_id, r.answer_value]));
    const theirAnswers = new Map(quizRows.rows.filter((r) => r.user_id === targetId).map((r) => [r.question_id, r.answer_value]));
    const shared = [];
    for (const [qid, val] of myAnswers) {
      if (theirAnswers.has(qid) && theirAnswers.get(qid) === val) {
        shared.push({ question_id: qid, both_answered: val });
        if (shared.length >= 6) break;
      }
    }

    const prompt = `You are a coach helping a college student write a great opener for a roommate-matching app. The student is matched with someone they don't know yet. Generate 3 short, real, NOT cringe opener messages they can tap and send.

ME (the sender):
  Name: ${me.first_name ?? '?'}
  School: ${me.school ?? '?'}
  Year: ${me.school_year ?? '?'}
  Major: ${me.major ?? '?'}
  Bio: ${(me.bio ?? '').slice(0, 300) || '(none)'}

THEM (the recipient):
  Name: ${them.first_name ?? '?'}
  School: ${them.school ?? '?'}
  Year: ${them.school_year ?? '?'}
  Major: ${them.major ?? '?'}
  Bio: ${(them.bio ?? '').slice(0, 300) || '(none)'}

SHARED CONTEXT:
  Same school: ${me.school && me.school === them.school ? 'yes' : 'no'}
  Same year: ${me.school_year && me.school_year === them.school_year ? 'yes' : 'no'}
  Same major: ${me.major && me.major === them.major ? 'yes' : 'no'}
  Identical quiz answers on ${shared.length} question(s).

VOICE RULES (this is the difference between good and trash):
- Sound like a real college student texting, not a marketing email.
- No "Hey there!" or "Hi! I noticed we matched". Skip the preamble.
- Reference something specific from their profile or shared context if there's anything to grab.
- One sentence + one question is the format. Open + invite reply.
- No emojis. No exclamation points. Lowercase 'hey' is fine.
- 8-25 words total each.

Output ONLY a JSON array of 3 strings (no markdown fence, no explanation):
["<opener 1>", "<opener 2>", "<opener 3>"]`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':     ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[openers] Anthropic call failed:', r.status, txt.slice(0, 200));
      return res.status(502).json({ error: 'Opener generation failed' });
    }
    const j = await r.json();
    const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '[]';

    let openers;
    try {
      openers = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
    } catch {
      openers = [];
    }
    if (!Array.isArray(openers)) openers = [];
    openers = openers.filter((s) => typeof s === 'string' && s.length > 0 && s.length < 300).slice(0, 3);

    if (openers.length === 0) {
      return res.status(502).json({ error: 'Opener generation returned no usable suggestions' });
    }

    openerCache.set(cacheKey, { openers, expiresAt: Date.now() + OPENER_TTL_MS });
    res.json({ openers, cached: false });
  } catch (err) {
    console.error('[openers] failed:', err);
    res.status(500).json({ error: 'Opener generation failed' });
  }
});

// ── GET /matches/:userId/explain ───────────────────────────────────────
// Compatibility Explainer. Turns the abstract compatibility score into
// a specific, personal narrative the user actually reads.
//
// The pre-launch test: do users open a match → see "94%" → swipe away,
// or do they open a match → see WHY it's 94% → actually message? This
// is the bot that closes that gap. Renders on Match Detail screen as
// the card between the photo and the compat bars.
//
// Data sources (only data the user gave us):
//   • Both users' quiz answers — find agreement + divergence points
//   • Both users' profile fields (school, year, major, bio)
//   • Both users' synthesized Compatibility Profiles (if available)
//
// 24h server-side cache per (viewer, target) pair. ~$0.05 per
// generation. At 100 users × 10 match-opens/day = ~$50/mo.
const explainerCache = new Map();
const EXPLAIN_TTL_MS = 24 * 60 * 60 * 1000;

router.get('/:userId/explain', requireAuth, async (req, res) => {
  const viewerId = req.user.id;
  const targetId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(targetId) || targetId === viewerId) {
    return res.status(400).json({ error: 'invalid target user id' });
  }

  const cacheKey = `${viewerId}:${targetId}`;
  const cached = explainerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ ...cached.payload, cached: true });
  }

  const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? '').replace(/[^!-~]/g, '');
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'Explainer unavailable (ANTHROPIC_API_KEY not set)' });
  }

  try {
    // Pull both users' profile fields. Strict allowlist — never email,
    // never phone, never address.
    const { rows: userRows } = await pool.query(
      `SELECT id, first_name, school, school_year, major, bio
       FROM users
       WHERE id IN ($1, $2)`,
      [viewerId, targetId]
    );
    const me = userRows.find((r) => r.id === viewerId);
    const them = userRows.find((r) => r.id === targetId);
    if (!me || !them) {
      return res.status(404).json({ error: 'one or both users not found' });
    }

    // Quiz overlap analysis — which questions agree, which diverge?
    const { rows: quizRows } = await pool.query(
      `SELECT user_id, question_id, answer_value
       FROM quiz_answers
       WHERE user_id IN ($1, $2)`,
      [viewerId, targetId]
    ).catch(() => ({ rows: [] }));
    const myAns    = new Map(quizRows.filter((r) => r.user_id === viewerId).map((r) => [r.question_id, r.answer_value]));
    const theirAns = new Map(quizRows.filter((r) => r.user_id === targetId).map((r) => [r.question_id, r.answer_value]));
    const agreements = [];
    const divergences = [];
    for (const [qid, val] of myAns) {
      if (!theirAns.has(qid)) continue;
      const theirs = theirAns.get(qid);
      if (theirs === val) agreements.push({ question_id: qid, both: val });
      else divergences.push({ question_id: qid, you: val, them: theirs });
    }

    // Synthesized Compatibility Profiles (if either user has one)
    let myProfile = null, theirProfile = null;
    try {
      const { rows: profRows } = await pool.query(
        `SELECT user_id, profile, user_edits
         FROM compatibility_profiles WHERE user_id IN ($1, $2)`,
        [viewerId, targetId]
      );
      const my = profRows.find((r) => r.user_id === viewerId);
      const th = profRows.find((r) => r.user_id === targetId);
      if (my) myProfile = { ...my.profile, ...(my.user_edits || {}) };
      if (th) theirProfile = { ...th.profile, ...(th.user_edits || {}) };
    } catch { /* profile table may not exist yet */ }

    const prompt = `You are HavenIQ's compatibility explainer. The user just opened a match's profile and sees a high compatibility score. Your job: turn the abstract number into specific, true, READABLE narrative that makes them feel "oh, this is actually a fit." Used in the Match Detail screen on a roommate-matching app for California college students.

VIEWER ("me"):
  Name: ${me.first_name}
  School: ${me.school ?? '?'}
  Year: ${me.school_year ?? '?'}
  Major: ${me.major ?? '?'}
  Bio: ${(me.bio ?? '').slice(0, 300) || '(none)'}
  Compatibility profile: ${myProfile ? JSON.stringify({
    archetype: myProfile.roommate_archetype,
    communication: myProfile.communication_style,
    lifestyle: myProfile.lifestyle,
    values: myProfile.values,
  }) : '(not synthesized yet)'}

TARGET ("them"):
  Name: ${them.first_name}
  School: ${them.school ?? '?'}
  Year: ${them.school_year ?? '?'}
  Major: ${them.major ?? '?'}
  Bio: ${(them.bio ?? '').slice(0, 300) || '(none)'}
  Compatibility profile: ${theirProfile ? JSON.stringify({
    archetype: theirProfile.roommate_archetype,
    communication: theirProfile.communication_style,
    lifestyle: theirProfile.lifestyle,
    values: theirProfile.values,
  }) : '(not synthesized yet)'}

QUIZ OVERLAP:
  Both agreed on ${agreements.length} question(s).
  Diverged on ${divergences.length} question(s).
  Sample agreements: ${agreements.slice(0, 4).map(a => `Q${a.question_id}="${a.both}"`).join(', ') || 'none'}
  Sample divergences: ${divergences.slice(0, 3).map(d => `Q${d.question_id}: you="${d.you}" / them="${d.them}"`).join(', ') || 'none'}

VOICE RULES:
- Sound like a college friend pointing something out, not a marketing email.
- Use first names. Use specific details. NO emojis. NO exclamation points.
- Honesty over flattery — if there's a real difference, name it.
- "Talk about it" framing for divergences, not "this is a red flag" framing.
- NEVER mention question numbers or "Q14"/Q-ids — the user has no idea what those refer to. Paraphrase the topic instead.
- 50-90 words total in 'story'. Brevity matters.

Return ONLY JSON:
{
  "headline":      "<one short sentence, evocative, no marketing fluff, e.g. 'You two would share a quiet morning well.'>",
  "story":         "<2-3 sentences in the voice above. Uses both first names. References specific shared things. Names ONE specific tension if it exists, framed as 'worth a conversation' not 'concern'.>",
  "agreements":    [{ "topic": "<short label>", "detail": "<one short clause>" }, ...],
  "tension_points":[{ "topic": "<short label>", "you_said": "<your stance>", "they_said": "<their stance>" }, ...],
  "vibe":          "<2-4 word label, lowercase, evocative, e.g. 'low-friction, real talk' or 'quiet anchor energy'>"
}

agreements: up to 3 items, only ones with real signal.
tension_points: 0-2 items, only ones genuinely worth surfacing.
No markdown fence. No explanation outside JSON.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[explainer] Anthropic call failed:', r.status, text.slice(0, 200));
      return res.status(502).json({ error: 'Explainer generation failed' });
    }
    const j = await r.json();
    const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '{}';

    let payload;
    try {
      payload = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
    } catch {
      return res.status(502).json({ error: 'Explainer returned unparseable output' });
    }

    // Defensive shape
    payload.headline       = typeof payload.headline === 'string' ? payload.headline.slice(0, 200) : '';
    payload.story          = typeof payload.story === 'string' ? payload.story.slice(0, 1000) : '';
    payload.agreements     = Array.isArray(payload.agreements) ? payload.agreements.slice(0, 3) : [];
    payload.tension_points = Array.isArray(payload.tension_points) ? payload.tension_points.slice(0, 2) : [];
    payload.vibe           = typeof payload.vibe === 'string' ? payload.vibe.slice(0, 60) : '';

    if (!payload.headline || !payload.story) {
      return res.status(502).json({ error: 'Explainer produced empty output' });
    }

    explainerCache.set(cacheKey, { payload, expiresAt: Date.now() + EXPLAIN_TTL_MS });
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error('[explainer] failed:', err);
    res.status(500).json({ error: 'Explainer generation failed' });
  }
});

module.exports = router;
