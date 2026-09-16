// ── Per-campus liquidity ─────────────────────────────────────────────────
//
// Lives in its own module so the SQL can be run against a real database by
// scripts/liquidity-check.js. A metrics endpoint whose query is only ever
// exercised through a stubbed pool is a query nobody has run.
const { notDemo } = require('./demoFilter');

// docs/first-campus-launch-playbook.md (app repo) is explicit that per-campus
// signups are a vanity number and names the metric that is missing:
//
//     "A campus with 200 signups but 25 quiz-complete women looking for fall
//      housing is not liquid for a woman looking for fall housing. Track
//      density per sub-pool, not per campus."
//     "extend the founder dashboard to show the liquidity gap per sub-pool"
//
// `schools[]` above answers "how many students here finished the quiz". That
// is the number the launch decision was being made on, and it can read healthy
// while the app cannot form a single suite for an entire gender.
//
// Sub-pools are NOT a partition. Gender-preference compatibility is mutual and
// pairwise, so there is no GROUP BY that expresses it. The honest per-student
// question is "how many people on my campus can actually reach me, and I
// them", and the campus answer is the DISTRIBUTION of that, reported at the
// bottom: a campus is liquid when its worst-served students have options, not
// when its median does.
//
// Reachability is computed with the SAME rules the match feed uses
// (src/routes/matches.js): quiz complete, not paused, not banned, mutual
// gender preference with the same inclusive defaults for an unset preference
// or "Prefer not to say", a compatibility_scores row at or above
// MATCH_MIN_SCORE that is not hard-blocked, and no user_block either way. A
// density number computed on different rules from the feed is fiction.
//
// NOT modelled here: move-in timing overlap, which the playbook also names.
// move_in_timeline is a free TEXT column ('1 month', '2 months', ...) with no
// canonical vocabulary and no date, so any overlap rule would be invented
// rather than derived, and the feed itself does not filter on it. Stated
// rather than silently dropped: this metric is campus + mutual preference +
// real compatibility, and is therefore an UPPER bound on true liquidity.
const ENGINE_FLOOR = 3;      // MIN_SUITE_SIZE: below this the optimizer cannot
                             // form even one suite (app utils/poolViability.ts)
const LIQUIDITY_FLOOR = 40;  // The low end of the playbook's 40-60 estimate for
                             // "a newcomer reliably finds several good matches".
                             // An ESTIMATE the playbook says to validate against
                             // the real funnel, not a measured constant.
const LIQUIDITY_SQL = `
  WITH cohort AS (
    SELECT u.id, u.school, u.gender, u.looking_for
      FROM users u
     WHERE u.school IS NOT NULL AND u.school <> ''
       AND u.quiz_completed IS TRUE
       AND COALESCE(u.is_paused, FALSE) = FALSE
       AND COALESCE(u.is_banned, FALSE) = FALSE
       AND ${notDemo('u.email')}
  ),
  reach AS (
    SELECT me.school, me.id, COUNT(them.id)::int AS reachable
      FROM cohort me
      LEFT JOIN cohort them
        ON them.school = me.school
       AND them.id <> me.id
       AND (me.looking_for IS NULL OR array_length(me.looking_for, 1) IS NULL
            OR them.gender IS NULL OR them.gender = 'Prefer not to say'
            OR them.gender = ANY(me.looking_for))
       AND (them.looking_for IS NULL OR array_length(them.looking_for, 1) IS NULL
            OR me.gender IS NULL OR me.gender = 'Prefer not to say'
            OR me.gender = ANY(them.looking_for))
       AND EXISTS (
         SELECT 1 FROM compatibility_scores cs
          WHERE ((cs.user_a = me.id AND cs.user_b = them.id)
              OR (cs.user_b = me.id AND cs.user_a = them.id))
            AND cs.is_hard_blocked = FALSE
            AND cs.score >= $1
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = me.id AND ub.blocked_id = them.id)
             OR (ub.blocker_id = them.id AND ub.blocked_id = me.id)
       )
     GROUP BY me.school, me.id
  )
  SELECT school,
         COUNT(*)::int                                                AS cohort,
         MIN(reachable)::int                                          AS worst,
         PERCENTILE_DISC(0.10) WITHIN GROUP (ORDER BY reachable)::int AS p10,
         PERCENTILE_DISC(0.50) WITHIN GROUP (ORDER BY reachable)::int AS median,
         (COUNT(*) FILTER (WHERE reachable < $2))::int                AS below_engine_floor
    FROM reach
   GROUP BY school
   ORDER BY cohort DESC, school ASC`;

module.exports = { ENGINE_FLOOR, LIQUIDITY_FLOOR, LIQUIDITY_SQL };
