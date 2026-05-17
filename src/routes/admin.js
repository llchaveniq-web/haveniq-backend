const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// Founder gate. Only user IDs listed here (comma-separated env var
// FOUNDER_USER_IDS) can reach the admin endpoints. Defaults to Jackson
// for development if the env var isn't set.
//
// Add new co-founder UUIDs by appending to the env var on Railway:
//   FOUNDER_USER_IDS=jackson-uuid,brother-uuid,third-uuid
const DEFAULT_FOUNDER_IDS = ['d5ade30f-be9f-45a8-bcb4-90be3ee25ecb'];
function getFounderIds() {
  const env = (process.env.FOUNDER_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return env.length > 0 ? env : DEFAULT_FOUNDER_IDS;
}

function requireFounder(req, res, next) {
  if (!getFounderIds().includes(req.user.id)) {
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

module.exports = router;
