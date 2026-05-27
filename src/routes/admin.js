const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { isFounder } = require('../utils/founders');
const { derivePersonality } = require('../services/personality');

function requireFounder(req, res, next) {
  if (!isFounder(req.user.id)) {
    return res.status(403).json({ error: 'Founders only' });
  }
  next();
}

// ── GET /admin/stats ─────────────────────────────────────────────────────
// Single-query cohort dashboard. Returns every meaningful collection-stream
// count in one round-trip so the founder dashboard renders in <300ms even
// over slow connections.
router.get('/stats', requireAuth, requireFounder, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        -- Headline funnel
        (SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@haveniq-demo.edu')
          AS real_signups,
        (SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@haveniq-demo.edu' AND quiz_completed = TRUE)
          AS quiz_finishers,
        (SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@haveniq-demo.edu' AND created_at > NOW() - INTERVAL '7 days')
          AS signups_this_week,
        (SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@haveniq-demo.edu' AND created_at > NOW() - INTERVAL '24 hours')
          AS signups_today,

        -- Per-school breakdown
        (SELECT COUNT(DISTINCT school) FROM users WHERE email NOT LIKE '%@haveniq-demo.edu')
          AS schools_represented,

        -- Collection-stream depth (proves pipelines work)
        (SELECT COUNT(*) FROM quiz_answers)                                          AS quiz_records,
        (SELECT COUNT(*) FROM consent_log)                                           AS consent_changes,
        (SELECT COUNT(*) FROM user_profile_snapshot)                                 AS snapshots,
        (SELECT COUNT(*) FROM telemetry_events)                                      AS behavioral_events,
        (SELECT COUNT(*) FROM compatibility_scores)                                  AS matches_computed,
        (SELECT COUNT(*) FROM connect_requests)                                      AS connect_attempts,
        (SELECT COUNT(*) FROM messages)                                              AS messages_sent,
        (SELECT COUNT(*) FROM profile_views)                                         AS profile_views,
        (SELECT COUNT(*) FROM push_tokens)                                           AS push_enabled,
        (SELECT COUNT(*) FROM roommate_reviews)                                      AS reviews,
        (SELECT COUNT(*) FROM match_pulses)                                          AS outcome_pulses,
        (SELECT COUNT(*) FROM match_checklists)                                      AS checklists,

        -- Real-real compatibility (between two real students, not demos)
        (SELECT COUNT(*)
         FROM compatibility_scores cs
         JOIN users a ON a.id = cs.user_a
         JOIN users b ON b.id = cs.user_b
         WHERE a.email NOT LIKE '%@haveniq-demo.edu'
           AND b.email NOT LIKE '%@haveniq-demo.edu')                                AS real_real_matches,

        -- Quiz funnel telemetry events (used to compute drop-off rates)
        (SELECT COUNT(*) FROM telemetry_events WHERE payload->>'action' = 'quiz_started')        AS quiz_starts,
        (SELECT COUNT(*) FROM telemetry_events WHERE payload->>'action' = 'quiz_milestone_25')   AS quiz_25_pct,
        (SELECT COUNT(*) FROM telemetry_events WHERE payload->>'action' = 'quiz_milestone_50')   AS quiz_50_pct,
        (SELECT COUNT(*) FROM telemetry_events WHERE payload->>'action' = 'quiz_milestone_75')   AS quiz_75_pct,
        (SELECT COUNT(*) FROM telemetry_events WHERE payload->>'action' = 'quiz_submitted')      AS quiz_submits,
        (SELECT COUNT(*) FROM telemetry_events WHERE payload->>'action' = 'quiz_submit_failed')  AS quiz_submit_fails
    `);

    // Per-school real-signup counts for the dashboard's "where students
    // are" panel. Returned alongside the headline metrics in one call.
    const { rows: schoolRows } = await pool.query(`
      SELECT school,
             COUNT(*)                              AS signups,
             COUNT(*) FILTER (WHERE quiz_completed) AS finishers
      FROM users
      WHERE email NOT LIKE '%@haveniq-demo.edu'
      GROUP BY school
      ORDER BY signups DESC
      LIMIT 25
    `);

    res.json({
      headline:    rows[0],
      bySchool:    schoolRows,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin/stats] query failed:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── POST /admin/backfill-personality ─────────────────────────────────────
// One-shot: derive + store a personality profile for every user who has
// completed the quiz but has no personality_profiles row yet (students who
// finished the quiz before the personality feature shipped). Responds
// immediately with the queued count, then derives sequentially in the
// background — one Anthropic call at a time so we never burst the API.
router.post('/backfill-personality', requireAuth, requireFounder, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT qa.user_id, qa.answers
      FROM quiz_answers qa
      LEFT JOIN personality_profiles pp ON pp.user_id = qa.user_id
      WHERE qa.completed = TRUE AND pp.user_id IS NULL
      LIMIT 500
    `);

    // Respond now — the derivation runs in the background after this.
    res.json({ success: true, queued: rows.length });

    (async () => {
      let done = 0, failed = 0;
      for (const row of rows) {
        try {
          const profile = await derivePersonality(row.answers);
          await pool.query(
            `INSERT INTO personality_profiles
               (user_id, archetype, ocean, summary, strengths, growth_areas, roommate_fit, model, source, mbti, disc)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (user_id) DO UPDATE
             SET archetype = $2, ocean = $3, summary = $4, strengths = $5,
                 growth_areas = $6, roommate_fit = $7, model = $8, source = $9,
                 mbti = $10, disc = $11, updated_at = NOW()`,
            [
              row.user_id, profile.archetype, JSON.stringify(profile.ocean),
              profile.summary, JSON.stringify(profile.strengths),
              JSON.stringify(profile.growth_areas), profile.roommate_fit,
              profile.model, profile.source, profile.mbti, profile.disc,
            ],
          );
          done++;
        } catch (e) {
          failed++;
          console.error('[backfill] user', row.user_id, e.message);
        }
      }
      console.log(`[backfill] personality done — ${done} ok, ${failed} failed`);
    })();
  } catch (err) {
    console.error('[admin/backfill-personality] failed:', err);
    res.status(500).json({ error: 'Backfill failed to start' });
  }
});

// ── Founder review queue ─────────────────────────────────────────────────
//
// Manual identity-vetting workflow used in lieu of paying Stripe Identity
// per-verification. The founder eyeballs each new signup against their
// .edu + photo + bio + signup-pattern. Approved users get is_verified=TRUE
// and the `.edu ✓` badge appears on their match cards; rejected users are
// banned. Until a user is reviewed, they're functional in-app but don't
// carry the trust badge to other students.
//
// Once daily volume exceeds ~30 signups/day we should bump this back into
// Stripe Identity (paid, $1.50/each, faster) — the manual path doesn't
// scale beyond a few hundred users without burning founder hours.

// GET /admin/review/pending — newest first, demos excluded
router.get('/review/pending', requireAuth, requireFounder, async (req, res) => {
  try {
    // Join user_profile_snapshot so we can run honesty-flag detection on
    // the bio vs the actual quiz answers. Snapshot column names mirror
    // the quiz answer schema (cleanliness, sleep, noise, etc.).
    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.school, u.first_name, u.last_initial, u.age,
             u.school_year, u.major, u.bio, u.photo_url, u.created_at,
             u.quiz_completed, u.is_banned,
             ups.cleanliness, ups.sleep, ups.noise, ups.guests, ups.alcohol
        FROM users u
        LEFT JOIN user_profile_snapshot ups ON ups.user_id = u.id
       WHERE u.email NOT LIKE '%@haveniq-demo.edu'
         AND u.is_verified = FALSE
         AND u.is_banned = FALSE
       ORDER BY u.created_at DESC
       LIMIT 100
    `);
    const { detectHonestyFlags } = require('../services/honestyFlags');
    res.json({
      pending: rows.map(r => ({
        id:            r.id,
        email:         r.email,
        school:        r.school,
        firstName:     r.first_name,
        lastInitial:   r.last_initial,
        age:           r.age,
        schoolYear:    r.school_year,
        major:         r.major,
        bio:           r.bio,
        photoUrl:      r.photo_url,
        createdAt:     r.created_at,
        quizCompleted: r.quiz_completed,
        // Honesty flags — bio claims vs quiz answers. Surfaced to the
        // founder so unusual mismatches get extra eyeballs. Empty array
        // = no flags = nothing unusual. Never user-visible.
        honestyFlags:  detectHonestyFlags({
          bio: r.bio,
          quiz: {
            cleanliness: r.cleanliness,
            sleep:       r.sleep,
            noise:       r.noise,
            guests:      r.guests,
            alcohol:     r.alcohol,
          },
        }),
      })),
      count: rows.length,
    });
  } catch (err) {
    console.error('[admin/review/pending] failed:', err);
    res.status(500).json({ error: 'Failed to fetch review queue' });
  }
});

// POST /admin/review/:userId/approve — flip is_verified=TRUE
router.post('/review/:userId/approve', requireAuth, requireFounder, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users
          SET is_verified = TRUE
        WHERE id = $1 AND email NOT LIKE '%@haveniq-demo.edu'
        RETURNING id, email, first_name`,
      [req.params.userId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    console.log(`[admin/review] APPROVED ${rows[0].email} by founder ${req.user.id}`);
    res.json({ ok: true, userId: rows[0].id });
  } catch (err) {
    console.error('[admin/review/approve] failed:', err);
    res.status(500).json({ error: 'Approve failed' });
  }
});

// POST /admin/review/:userId/reject — ban with reason
router.post('/review/:userId/reject', requireAuth, requireFounder, async (req, res) => {
  const reason = (req.body?.reason ?? 'failed manual review').toString().slice(0, 200);
  try {
    const { rows } = await pool.query(
      `UPDATE users
          SET is_banned = TRUE,
              ban_reason = $2,
              banned_at = NOW()
        WHERE id = $1 AND email NOT LIKE '%@haveniq-demo.edu'
        RETURNING id, email`,
      [req.params.userId, reason],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    console.log(`[admin/review] REJECTED ${rows[0].email} by founder ${req.user.id}: ${reason}`);
    res.json({ ok: true, userId: rows[0].id });
  } catch (err) {
    console.error('[admin/review/reject] failed:', err);
    res.status(500).json({ error: 'Reject failed' });
  }
});

// ── Weekly parent digest trigger ─────────────────────────────────────────
//
// POST /admin/parent-digest/send-week
// Sends the weekly parent-digest email to every parent whose student has
// (a) parent_email set, (b) parent_notified=TRUE (opted in via first-
// match), and (c) any meaningful activity in the past 7 days (matches,
// connections, or quiz progress). Founder-gated so it can't be abused
// by ordinary users.
//
// Manual today; Railway cron job can hit this on a Sunday schedule
// without code changes — just POST to this endpoint with the founder JWT.
router.post('/parent-digest/send-week', requireAuth, requireFounder, async (req, res) => {
  const { sendParentDigestEmail } = require('../services/email');
  try {
    // Pull eligible parent/student pairs + their week-over-week activity.
    // LEFT JOINs on connect_requests + conversations + match counts let us
    // build the digest from a single round-trip rather than N queries.
    const { rows } = await pool.query(`
      SELECT
        u.id, u.first_name, u.parent_email, u.quiz_completed, u.photo_url,
        u.bio, u.major, u.school_year,
        (SELECT COUNT(*) FROM compatibility_scores cs
           WHERE (cs.user_a = u.id OR cs.user_b = u.id)
             AND cs.created_at > NOW() - INTERVAL '7 days')                AS matches_week,
        (SELECT COUNT(*) FROM connect_requests cr
           WHERE (cr.from_user_id = u.id OR cr.to_user_id = u.id)
             AND cr.status = 'accepted'
             AND cr.accepted_at > NOW() - INTERVAL '7 days')               AS connections_week,
        (SELECT COUNT(*) FROM conversations c
           WHERE (c.user_a = u.id OR c.user_b = u.id))                     AS conversations_active
        FROM users u
       WHERE u.parent_email IS NOT NULL
         AND u.parent_email <> ''
         AND u.parent_notified = TRUE
         AND u.is_banned = FALSE
         AND u.email NOT LIKE '%@haveniq-demo.edu'
    `);

    let sent = 0;
    const errors = [];
    for (const r of rows) {
      // Profile-completeness pct mirrors the frontend's calculation —
      // a rough proxy so the parent sees their student's progress arc.
      const items = [
        !!r.first_name, !!r.major, !!r.bio, !!r.school_year,
        !!r.photo_url, !!r.quiz_completed,
      ];
      const pct = Math.round(items.filter(Boolean).length / items.length * 100);

      try {
        await sendParentDigestEmail({
          parentEmail:         r.parent_email,
          studentFirstName:    r.first_name,
          matchesThisWeek:     parseInt(r.matches_week)      || 0,
          connectionsThisWeek: parseInt(r.connections_week)  || 0,
          conversationsActive: parseInt(r.conversations_active) || 0,
          profilePctComplete:  pct,
          hasQuizCompleted:    !!r.quiz_completed,
          hasPhoto:            !!r.photo_url,
        });
        sent++;
      } catch (err) {
        errors.push({ userId: r.id, error: err.message });
      }
    }

    console.log(`[admin/parent-digest] sent=${sent}, errors=${errors.length}`);
    res.json({ ok: true, sent, eligible: rows.length, errors });
  } catch (err) {
    console.error('[admin/parent-digest] failed:', err);
    res.status(500).json({ error: 'Parent digest send failed' });
  }
});

module.exports = router;
