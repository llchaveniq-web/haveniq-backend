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
    // LATERAL join pulls the user's MOST RECENT user_profile_snapshot
    // (one row per quiz_submit historically), and we read quiz dimensions
    // out of the JSONB `snapshot` blob — NOT as columns on the snapshot
    // table (which doesn't have them; see schema.sql:194). Earlier
    // version of this code assumed column-per-dimension and threw a
    // "column does not exist" error on every founder-queue load.
    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.school, u.first_name, u.last_initial, u.age,
             u.school_year, u.major, u.bio, u.photo_url, u.created_at,
             u.quiz_completed, u.is_banned,
             ups.snapshot AS quiz_snapshot
        FROM users u
        LEFT JOIN LATERAL (
          SELECT snapshot
            FROM user_profile_snapshot
           WHERE user_id = u.id::text  -- prod schema: user_id is TEXT, not UUID
           ORDER BY updated_at DESC    -- prod schema has updated_at, not created_at
           LIMIT 1
        ) ups ON TRUE
       WHERE u.email NOT LIKE '%@haveniq-demo.edu'
         AND u.is_verified = FALSE
         AND u.is_banned = FALSE
       ORDER BY u.created_at DESC
       LIMIT 100
    `);
    const { detectHonestyFlags } = require('../services/honestyFlags');
    res.json({
      pending: rows.map(r => {
        // pg auto-parses JSONB columns to JS objects, so r.quiz_snapshot
        // is already { cleanliness, sleep, ... } — or null if the user
        // hasn't taken the quiz yet.
        const quiz = r.quiz_snapshot || {};
        return {
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
              cleanliness: quiz.cleanliness,
              sleep:       quiz.sleep,
              noise:       quiz.noise,
              guests:      quiz.guests,
              alcohol:     quiz.alcohol,
            },
          }),
        };
      }),
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

// ── POST /admin/seed-demos ───────────────────────────────────────────────
//
// One-shot demo-user seeder. Railway's dashboard Query interface rewrites
// SELECT-shaped INSERTs by appending LIMIT (which Postgres doesn't allow
// on INSERT...RETURNING + DO blocks), so the seed_200_demo_users.sql
// file can't be pasted into Railway directly. This endpoint runs the
// same logic server-side via pg.Pool, which has no such rewriting.
//
// Founder-gated. Idempotent via ON CONFLICT (email) DO NOTHING — safe
// to re-run; existing demos stay put. Inserts up to 200 demo users +
// their user_profile_snapshot quiz answers. Demos are gated to the
// @haveniq-demo.edu domain so they never appear in real students' feeds.
router.post('/seed-demos', requireAuth, requireFounder, async (req, res) => {
  try {
    // First INSERT: the 200 demo user rows.
    const insertUsers = await pool.query(`
      WITH varied AS (
        SELECT
          n,
          (ARRAY['Aisha','Maya','Jordan','Sam','Priya','Olivia','Riley','Alex','Morgan','Casey','Sofia','Noah','Emma','Liam','Ava','Ethan','Isabella','Mason','Mia','Lucas','Charlotte','Logan','Amelia','Oliver','Harper','Elijah','Evelyn','Carter','Aria','Sebastian'])[1 + (n - 1) % 30] AS first_name,
          chr(65 + ((n - 1) % 26))::TEXT AS last_initial,
          (ARRAY['UC Berkeley','UCLA','USC','Stanford','Cal Poly SLO','UC San Diego','UC Irvine','San Diego State'])[1 + (n - 1) % 8] AS school,
          (ARRAY['berkeley.edu','ucla.edu','usc.edu','stanford.edu','calpoly.edu','ucsd.edu','uci.edu','sdsu.edu'])[1 + (n - 1) % 8] AS school_domain,
          (ARRAY['Freshman','Sophomore','Sophomore','Junior','Junior','Senior'])[1 + (n - 1) % 6] AS school_year,
          18 + (n % 6) AS age,
          (ARRAY['Psychology','Computer Science','Biology','Business','English','Engineering','Communications','Economics','Art History','Political Science'])[1 + (n - 1) % 10] AS major,
          (ARRAY['Woman','Man','Woman','Man','Nonbinary','Woman','Man'])[1 + (n - 1) % 7] AS gender,
          (ARRAY[
            'Early riser, lots of coffee, library is my second home. Looking for someone tidy who respects quiet study time.',
            'Night owl — I do my best work after 11pm. Promise to be quiet when youre sleeping. Big fan of meal-prep Sundays.',
            'Pre-med, so my schedules intense. Need someone who gets that and doesnt take it personally when Im buried in books.',
            'Love hosting small dinners, hate big parties at home. Looking for someone with a similar energy.',
            'Im a chaos-good kind of clean — surfaces are tidy, my desk is a wreck. Honesty about how you actually live > pretending.',
            'Cross-country runner, so up at 6am most days. Bed by 10pm. If youre a night owl well need to negotiate.',
            'Art major, so my room often has supplies everywhere. Communal spaces stay clean though. Promise.',
            'Quiet, low-maintenance, and I dont need to be best friends — just respectful roommates who get the basics right.',
            'Love cooking, hate cleaning dishes. If youre the opposite this is a match made in heaven.',
            'Im a planner — Id rather over-communicate than guess. Looking for someone whos on the same page.',
            'Music major, mostly headphones, occasionally need to practice out loud. Will warn you. Will not surprise you.',
            'Engineering, lots of group projects on Zoom. Decent at chores, terrible at remembering to take out the trash. Working on it.'
          ])[1 + (n - 1) % 12] AS bio,
          700 + ((n % 8) * 100) AS budget_min,
          1100 + ((n % 6) * 200) AS budget_max
        FROM generate_series(1, 200) AS n
      )
      INSERT INTO users (
        email, school, school_domain, first_name, last_name,
        bio, major, school_year, age, gender,
        budget_min, budget_max, is_verified, quiz_completed, trust_score
      )
      SELECT
        'demo' || lpad(n::TEXT, 3, '0') || '@haveniq-demo.edu',
        school, school_domain, first_name, last_initial,
        bio, major, school_year, age, gender,
        budget_min, budget_max, TRUE, TRUE, 85
      FROM varied
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `);

    // Second INSERT: varied profile-snapshot quiz answers for each new
    // demo. PROD SCHEMA NOTE (verified 2026-05-27 via information_schema):
    // user_profile_snapshot.user_id is TEXT in production, not UUID as
    // schema.sql suggests. There's been schema drift between code and
    // prod — the prod table has 16 columns (writing_fingerprint,
    // typing_fingerprint, top_values, etc.) from a richer earlier design,
    // while the code only knows about the trigger + snapshot pair.
    // Both trigger + snapshot columns DO exist in prod (positions 15-16),
    // so we just cast u.id to text on the way in.
    const insertSnapshots = await pool.query(`
      INSERT INTO user_profile_snapshot (user_id, trigger, snapshot)
      SELECT
        u.id::text,
        'demo_seed',
        jsonb_build_object(
          'cleanliness',   (ARRAY['Very tidy','Tidy','Average','Relaxed'])[1 + (random() * 3)::INT],
          'sleep',         (ARRAY['Early bird (before 10pm)','Night owl (after midnight)','Flexible'])[1 + (random() * 2)::INT],
          'noise',         (ARRAY['Very quiet','Quiet','Moderate','Lively'])[1 + (random() * 3)::INT],
          'guests',        (ARRAY['Rarely','Occasionally','Frequently'])[1 + (random() * 2)::INT],
          'alcohol',       (ARRAY['Never','Occasionally','Regularly'])[1 + (random() * 2)::INT],
          'pets',          (ARRAY['No pets','Pet-friendly','Allergic'])[1 + (random() * 2)::INT],
          'money',         (ARRAY['Split evenly','Track everything','Flexible'])[1 + (random() * 2)::INT],
          'communication', (ARRAY['Direct','Indirect','Mixed'])[1 + (random() * 2)::INT],
          'space',         (ARRAY['Need lots of space','Some space','Social'])[1 + (random() * 2)::INT]
        )
      FROM users u
      WHERE u.email LIKE 'demo%@haveniq-demo.edu'
        AND NOT EXISTS (SELECT 1 FROM user_profile_snapshot WHERE user_id = u.id::text)
      RETURNING user_id
    `);

    // Third INSERT: quiz_answers for each demo. Required because the
    // matches feed JOINs against compatibility_scores, and those rows
    // only get populated when scoreNewMatches() runs — which itself
    // needs each user to have quiz_answers. Without this step the
    // demos exist but never appear in any feed.
    //
    // We generate deterministic-ish random answers via random()::INT
    // across all 26 questions. Index 0-2 keeps every answer within
    // the valid range for both 3-option AND 4-option questions, so
    // the scoring engine never trips on out-of-range option indices.
    //
    // The 26 question IDs are pulled from data/quizQuestions.js
    // (non-contiguous because the v5 quiz preserved IDs from the
    // original 60-question set).
    const QUIZ_IDS = [1,3,9,14,15,17,22,25,29,31,32,33,35,37,38,42,45,47,50,54,55,57,58,60];
    const answersJsonExpr = QUIZ_IDS
      .map(id => `'${id}', (random() * 2)::INT`)
      .join(', ');
    const insertQuizAnswers = await pool.query(`
      INSERT INTO quiz_answers (user_id, answers, completed)
      SELECT
        u.id,
        jsonb_build_object(${answersJsonExpr}),
        TRUE
      FROM users u
      WHERE u.email LIKE 'demo%@haveniq-demo.edu'
        AND NOT EXISTS (SELECT 1 FROM quiz_answers WHERE user_id = u.id)
      RETURNING user_id
    `);

    // Fourth step: score the founder against all the newly-quiz'd demos
    // so they show up in the founder's matches feed. We pull the founder's
    // own quiz answers from quiz_answers; if they haven't taken the quiz
    // yet we skip this step + return a message saying so.
    let scoringRan = false;
    let scoringMessage = '';
    const { rows: myQuizRows } = await pool.query(
      `SELECT answers FROM quiz_answers WHERE user_id = $1 AND completed = TRUE LIMIT 1`,
      [req.user.id]
    );
    if (myQuizRows.length === 0) {
      scoringMessage = 'Founder has not completed the quiz — take it in-app, then re-run this endpoint to populate compatibility scores against the demos.';
    } else {
      // Mirror the scoreNewMatches flow from quiz.js: pull all candidates'
      // quiz answers + dealbreakers, compute compat, bulk-INSERT the
      // compatibility_scores rows. Keep it simple — no MBTI blend for
      // demos (their personality_profiles row doesn't exist).
      const myAnswers = myQuizRows[0].answers;
      const { rows: otherUsers } = await pool.query(
        `SELECT qa.user_id, qa.answers, u.dealbreakers
           FROM quiz_answers qa
           JOIN users u ON u.id = qa.user_id
          WHERE qa.completed = TRUE
            AND qa.user_id != $1
            AND u.is_paused = FALSE
            AND u.email LIKE 'demo%@haveniq-demo.edu'`,
        [req.user.id]
      );
      const { calculateCompatibility } = require('../services/scoring');
      const { rows: meDealRow } = await pool.query(
        `SELECT dealbreakers FROM users WHERE id = $1`,
        [req.user.id]
      );
      const myDealbreakers = Array.isArray(meDealRow[0]?.dealbreakers) ? meDealRow[0].dealbreakers : [];

      const scoreRows = [];
      for (const other of otherUsers) {
        const theirDealbreakers = Array.isArray(other.dealbreakers) ? other.dealbreakers : [];
        const combined = [...new Set([...myDealbreakers, ...theirDealbreakers])];
        const result = calculateCompatibility(myAnswers, other.answers, { dealbreakers: combined });
        // Consistent with scoreNewMatches: don't skip hard-blocked pairs —
        // write the row (score 0, is_hard_blocked = TRUE) so it's visible
        // and debuggable. The feed filters score >= 50 AND
        // is_hard_blocked = FALSE, so these never surface to users.
        // Order user_a/user_b lexically so we don't double-insert (A→B
        // and B→A are the same pair) — matches the same ordering quiz.js
        // uses on its bulk insert.
        const [a, b] = [req.user.id, other.user_id].sort();
        scoreRows.push({
          user_a: a, user_b: b,
          score: result.finalPct,
          breakdown: JSON.stringify(result.categoryBreakdown || []),
          why_matched: JSON.stringify(result.whyMatched || []),
          is_soft_blocked: !!result.isSoftBlocked,
          is_hard_blocked: !!result.isHardBlocked,
          shadow_penalty: result.shadowPenalty ?? 0,
        });
      }

      // Bulk insert all the score rows. ON CONFLICT (user_a, user_b)
      // DO UPDATE keeps the latest score per pair — re-running this
      // endpoint refreshes existing scores cleanly.
      if (scoreRows.length > 0) {
        const placeholders = scoreRows.map((_, i) => {
          const base = i * 8;
          return `($${base+1}, $${base+2}, $${base+3}, $${base+4}::jsonb, $${base+5}::jsonb, $${base+6}, $${base+7}, $${base+8})`;
        }).join(', ');
        const values = scoreRows.flatMap(r => [
          r.user_a, r.user_b, r.score, r.breakdown, r.why_matched,
          r.is_soft_blocked, r.is_hard_blocked, r.shadow_penalty,
        ]);
        await pool.query(
          `INSERT INTO compatibility_scores
             (user_a, user_b, score, breakdown, why_matched, is_soft_blocked, is_hard_blocked, shadow_penalty)
           VALUES ${placeholders}
           ON CONFLICT (user_a, user_b) DO UPDATE SET
             score = EXCLUDED.score,
             breakdown = EXCLUDED.breakdown,
             why_matched = EXCLUDED.why_matched,
             is_soft_blocked = EXCLUDED.is_soft_blocked,
             shadow_penalty = EXCLUDED.shadow_penalty`,
          values
        );
      }
      scoringRan = true;
      scoringMessage = `Scored founder against ${scoreRows.length} demos (others were hard-blocked).`;
    }

    // Summary counts — final state of demos in the DB after this seed.
    const counts = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE email LIKE 'demo%@haveniq-demo.edu') AS total,
        COUNT(DISTINCT school) FILTER (WHERE email LIKE 'demo%@haveniq-demo.edu') AS schools
      FROM users
    `);

    res.json({
      ok: true,
      usersInsertedThisRun:        insertUsers.rowCount,
      snapshotsInsertedThisRun:    insertSnapshots.rowCount,
      quizAnswersInsertedThisRun:  insertQuizAnswers.rowCount,
      scoringRan,
      scoringMessage,
      demoUsersTotal:              parseInt(counts.rows[0].total),
      demoSchoolsTotal:            parseInt(counts.rows[0].schools),
    });
  } catch (err) {
    console.error('[admin/seed-demos] failed:', err);
    res.status(500).json({ error: 'Seed failed', detail: err.message });
  }
});

module.exports = router;
