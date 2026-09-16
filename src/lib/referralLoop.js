// ── The realized referral loop, per campus ───────────────────────────────
//
// docs/first-campus-launch-playbook.md §5.2 names this as the open-the-doors
// signal: "k-factor: invites sent x accept-rate x quiz-complete-rate. > 1 on a
// campus = self-sustaining; that's the real 'open the doors' signal."
//
// What is computed here is deliberately NOT that product. Invites SENT live in
// PostHog (invite_shared), fired client-side, and the current build has no
// PostHog key, so the send count is zero-by-construction and any k built on it
// would be a fraction with a fabricated denominator. Worse, it would read as a
// healthy small number while measuring nothing.
//
// So this measures the REALIZED loop, which needs no send data at all:
//
//     k = new quiz-complete students attributed to a referral
//         ---------------------------------------------------
//         students already on this campus who could have referred them
//
// That is the coefficient that actually decides whether a campus carries
// itself. Sends only matter afterwards, for diagnosing WHY k is low (nobody
// shared, or people shared and nobody converted), and that diagnosis becomes
// possible the day the PostHog key is set.
//
// Campus is taken from the REFERRED student, not the referrer. A student who
// pulls in a friend at another school has grown HavenIQ and has not made their
// own campus any more liquid, and campus liquidity is the thing this number
// exists to predict.
const { notDemo } = require('./demoFilter');

// referrals/referral_codes are created lazily by src/routes/referrals.js on
// first use, so on a database where nobody has ever generated a code the table
// genuinely does not exist. Unguarded, /admin/metrics throws 42P01 and the
// WHOLE founder dashboard 500s -- every number on it lost because the growth
// loop has not started yet, which is exactly when a founder is looking.
//
// The first version of this guard was a `WITH present AS (SELECT
// to_regclass('public.referrals') IS NOT NULL)` CTE gating the join. It cannot
// work and it was never going to: Postgres resolves every relation in the
// parse, before a single row is read, so `FROM referrals` raises 42P01
// whatever the WHERE clause says. Verified against 16.13 with the table
// dropped -- the query failed exactly as it would have in production, on a
// guard that read as careful.
//
// The existence check has to happen in a SEPARATE statement, which is what
// fetchReferralLoop below does.
const CAMPUS_ONLY_SQL = `
  SELECT u.school,
         COUNT(*)::int AS quiz_complete,
         0 AS referred, 0 AS referred_quiz_complete, 0 AS referrers
    FROM users u
   WHERE u.school IS NOT NULL AND u.school <> ''
     AND u.quiz_completed IS TRUE
     AND COALESCE(u.is_banned, FALSE) = FALSE
     AND ${notDemo('u.email')}
   GROUP BY u.school
   ORDER BY quiz_complete DESC, u.school ASC`;

const REFERRAL_LOOP_SQL = `
  WITH campus AS (
    SELECT u.school,
           COUNT(*)::int AS quiz_complete
      FROM users u
     WHERE u.school IS NOT NULL AND u.school <> ''
       AND u.quiz_completed IS TRUE
       AND COALESCE(u.is_banned, FALSE) = FALSE
       AND ${notDemo('u.email')}
     GROUP BY u.school
  ),
  attributed AS (
    SELECT ref.school,
           COUNT(*)::int                                                  AS referred,
           (COUNT(*) FILTER (WHERE ref.quiz_completed IS TRUE))::int      AS referred_quiz_complete,
           COUNT(DISTINCT r.referrer_id)::int                             AS referrers
      FROM referrals r
      JOIN users ref ON ref.id::text = r.referred_id
     WHERE ref.school IS NOT NULL AND ref.school <> ''
       AND COALESCE(ref.is_banned, FALSE) = FALSE
       AND ${notDemo('ref.email')}
     GROUP BY ref.school
  )
  SELECT c.school,
         c.quiz_complete,
         COALESCE(a.referred, 0)               AS referred,
         COALESCE(a.referred_quiz_complete, 0) AS referred_quiz_complete,
         COALESCE(a.referrers, 0)              AS referrers
    FROM campus c
    LEFT JOIN attributed a ON a.school = c.school
   ORDER BY c.quiz_complete DESC, c.school ASC`;

// Below this many students on a campus, k is one or two events divided by a
// tiny number and swings wildly. Reported as null rather than as a number,
// because a k of 2.0 built on two signups is the kind of figure that gets
// screenshotted into a deck.
const K_MIN_COHORT = 10;

function shapeReferralLoop(rows) {
  return rows.map(r => {
    const cohort = r.quiz_complete;
    const converted = r.referred_quiz_complete;
    // The denominator is everyone who was already here and could have
    // referred, minus the people the referrals themselves brought in: counting
    // the referred among the referrers flatters k as the loop runs.
    const base = Math.max(0, cohort - converted);
    return {
      school: r.school,
      quizCompleteOnCampus: cohort,
      referrers: r.referrers,
      referredSignups: r.referred,
      // The referrals that became actual pool members. A referred student who
      // never finished the quiz is not in anybody's matches and did not make
      // this campus more liquid.
      referredQuizComplete: converted,
      k: base >= K_MIN_COHORT ? Math.round((converted / base) * 100) / 100 : null,
      // Said out loud so a null is not read as a zero.
      kSuppressedBelow: K_MIN_COHORT,
    };
  });
}

/**
 * Rows for the referral-loop block, with the table-does-not-exist case handled
 * where it can be: in JS, as its own statement, before the query that needs it.
 */
async function fetchReferralLoop(pool) {
  const probe = await pool.query(`SELECT to_regclass('public.referrals') IS NOT NULL AS ok`);
  const ok = probe && probe.rows && probe.rows[0] && probe.rows[0].ok === true;
  const { rows } = await pool.query(ok ? REFERRAL_LOOP_SQL : CAMPUS_ONLY_SQL);
  return rows;
}

module.exports = {
  REFERRAL_LOOP_SQL, CAMPUS_ONLY_SQL, K_MIN_COHORT, shapeReferralLoop, fetchReferralLoop,
};
