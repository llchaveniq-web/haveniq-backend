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
               (user_id, archetype, ocean, summary, strengths, growth_areas, roommate_fit, model, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (user_id) DO UPDATE
             SET archetype = $2, ocean = $3, summary = $4, strengths = $5,
                 growth_areas = $6, roommate_fit = $7, model = $8, source = $9,
                 updated_at = NOW()`,
            [
              row.user_id, profile.archetype, JSON.stringify(profile.ocean),
              profile.summary, JSON.stringify(profile.strengths),
              JSON.stringify(profile.growth_areas), profile.roommate_fit,
              profile.model, profile.source,
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

module.exports = router;
