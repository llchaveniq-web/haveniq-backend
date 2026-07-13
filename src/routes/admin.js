const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireFounder } = require('../middleware/requireFounder');
const { hashOtp, MAX_OTP_ATTEMPTS } = require('../lib/otp');
const { generateOTP, sendOTPEmail } = require('../services/email');
const { notDemo } = require('../lib/demoFilter');
const { generateApiSecret, hashApiKey } = require('../lib/apiKeys');

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
    console.log(`[admin/review] APPROVED user ${rows[0].id} by founder ${req.user.id}`);
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
    console.log(`[admin/review] REJECTED user ${rows[0].id} by founder ${req.user.id}: ${reason}`);
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

// ── Founder account support ──────────────────────────────────────────────
// Lets the founder unstick a user who's locked out of the OTP flow (failed too
// many codes) without hand-editing the DB. Same isFounder gate + 403 as every
// other route here. Mutations address the user by ID and use their STORED email
// — never an email from the request body (a body email would let a caller act on
// an address they don't own).
//
// `locked_until`: the OTP lockout the /verify-code flow enforces lives in
// otp_codes — after MAX_OTP_ATTEMPTS wrong guesses the code is burned. We surface
// it as the expiry of the most recent code that hit the attempt cap and is still
// inside its 10-min window; null once it expires or is cleared. resend/unlock
// delete those rows so the user can try again immediately.

// GET /admin/users/lookup?email=<exact email>
router.get('/users/lookup', requireAuth, requireFounder, async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) return res.status(400).json({ error: 'email query param required' });
  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, school, is_verified,
              COALESCE(is_banned, FALSE) AS is_banned, ban_reason,
              quiz_completed, created_at, last_active_at
         FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email],
    );
    if (!rows[0]) return res.json({ user: null });
    const u = rows[0];
    const { rows: lock } = await pool.query(
      `SELECT MAX(expires_at) AS locked_until FROM otp_codes
        WHERE email = $1 AND expires_at > NOW() AND attempts >= $2`,
      [String(u.email).toLowerCase(), MAX_OTP_ATTEMPTS],
    );
    res.json({ user: {
      ...u,
      locked_until: lock[0] && lock[0].locked_until ? new Date(lock[0].locked_until).toISOString() : null,
    } });
  } catch (err) {
    console.error('[admin/users/lookup] failed:', err);
    res.status(500).json({ error: 'lookup failed' });
  }
});

// POST /admin/users/:id/resend-otp — re-trigger the /auth/send-code flow for the
// user's own email (clears any burned codes, issues + emails a fresh one).
router.post('/users/:id/resend-otp', requireAuth, requireFounder, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'user not found' });
    const email = String(rows[0].email).toLowerCase();

    // Clear any pending/burned codes, then issue a fresh one (mirrors send-code:
    // hashed at rest, 10-min expiry). Deleting clears the lockout in one step.
    await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);
    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      'INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)',
      [email, hashOtp(code), expiresAt],
    );
    try {
      await sendOTPEmail(email, code);
    } catch (e) {
      console.error('[admin/resend-otp] email send failed:', e.message);
    }
    res.json({ sent: true });
  } catch (err) {
    console.error('[admin/users/:id/resend-otp] failed:', err);
    res.status(500).json({ error: 'resend failed' });
  }
});

// POST /admin/users/:id/unlock — clear the OTP lockout/cooldown (the attempts
// lockout the verify-code flow enforces) so the user can try again.
router.post('/users/:id/unlock', requireAuth, requireFounder, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'user not found' });
    await pool.query('DELETE FROM otp_codes WHERE email = $1', [String(rows[0].email).toLowerCase()]);
    res.json({ user: { id: rows[0].id, email: rows[0].email, locked_until: null } });
  } catch (err) {
    console.error('[admin/users/:id/unlock] failed:', err);
    res.status(500).json({ error: 'unlock failed' });
  }
});

// ── GET /admin/users/:id/subscription ────────────────────────────────────
// Founder view of a user's premium subscription. Forward-compatible: until the
// premium product ships the subscriptions table is empty, so every (existing)
// user returns the {status:'none', …} default — safe to deploy now. Once Stripe
// is wired and writes rows, the same query populates the real fields. 404 if the
// user doesn't exist.
const NONE_SUBSCRIPTION = {
  status: 'none', plan: null, priceLabel: null,
  currentPeriodEnd: null, cancelAtPeriodEnd: false, since: null,
};
router.get('/users/:id/subscription', requireAuth, requireFounder, async (req, res) => {
  try {
    const { rows: u } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!u[0]) return res.status(404).json({ error: 'user not found' });

    const { rows } = await pool.query(
      `SELECT status, plan, price_label, current_period_end, cancel_at_period_end, created_at
         FROM subscriptions WHERE user_id = $1 LIMIT 1`,
      [req.params.id],
    );
    const s = rows[0];
    const subscription = s ? {
      status:            s.status || 'none',
      plan:              s.plan ?? null,
      priceLabel:        s.price_label ?? null,
      currentPeriodEnd:  s.current_period_end ? new Date(s.current_period_end).toISOString() : null,
      cancelAtPeriodEnd: s.cancel_at_period_end === true,
      since:             s.created_at ? new Date(s.created_at).toISOString() : null,
    } : { ...NONE_SUBSCRIPTION };

    res.json({ subscription });
  } catch (err) {
    console.error('[admin/users/:id/subscription] failed:', err);
    res.status(500).json({ error: 'subscription lookup failed' });
  }
});

// ── GET /admin/metrics ────────────────────────────────────────────────────
// Founder dashboard counts (same gate + 403). All single COUNT / GROUP BY
// queries, run in parallel, cached ~60s so a dashboard refresh loop is cheap.
// `lastTrainingRun` = the most recent dimension_models.updated_at — the trainer
// (train-dimension-models / the daily sweep) upserts every row on each run.
let _metricsCache = null; // { at, data }
const METRICS_TTL_MS = 60 * 1000;

async function computeMetrics() {
  const [users, schools, outcomes, shapes, lastRun, reports, banned] = await Promise.all([
    // User + school counts exclude demo/test accounts (both demo domains) so the
    // dashboard reflects real traction, not seed inflation. Safety counts below
    // are intentionally left unfiltered.
    pool.query(`SELECT COUNT(*)::int AS total,
                       (COUNT(*) FILTER (WHERE is_verified IS TRUE))::int    AS verified,
                       (COUNT(*) FILTER (WHERE quiz_completed IS TRUE))::int AS quiz_completed
                  FROM users
                 WHERE ${notDemo('email')}`),
    pool.query(`SELECT school,
                       COUNT(*)::int AS users,
                       (COUNT(*) FILTER (WHERE is_verified IS TRUE))::int    AS verified,
                       (COUNT(*) FILTER (WHERE quiz_completed IS TRUE))::int AS quiz_completed
                  FROM users
                 WHERE school IS NOT NULL AND school <> ''
                   AND ${notDemo('email')}
                 GROUP BY school
                 ORDER BY users DESC, school ASC`),
    pool.query(`SELECT COUNT(*)::int AS n FROM pairing_outcomes`),
    pool.query(`SELECT qid, type FROM dimension_models WHERE certified = TRUE ORDER BY qid`),
    pool.query(`SELECT MAX(updated_at) AS last FROM dimension_models`),
    pool.query(`SELECT COUNT(*)::int AS n FROM user_reports WHERE status = 'open'`),
    pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE COALESCE(is_banned, FALSE) = TRUE`),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    users: {
      total:         users.rows[0].total,
      verified:      users.rows[0].verified,
      quizCompleted: users.rows[0].quiz_completed,
    },
    schools: schools.rows.map(r => ({
      school: r.school, users: r.users, verified: r.verified, quizCompleted: r.quiz_completed,
    })),
    matching: {
      outcomesLogged:  outcomes.rows[0].n,
      certifiedShapes: shapes.rows.map(r => ({ qid: r.qid, type: r.type })),
      lastTrainingRun: lastRun.rows[0].last ? new Date(lastRun.rows[0].last).toISOString() : null,
    },
    safety: {
      openReports: reports.rows[0].n,
      bannedUsers: banned.rows[0].n,
    },
  };
}

router.get('/metrics', requireAuth, requireFounder, async (req, res) => {
  try {
    const now = Date.now();
    if (_metricsCache && now - _metricsCache.at < METRICS_TTL_MS) {
      return res.json(_metricsCache.data);
    }
    const data = await computeMetrics();
    _metricsCache = { at: now, data };
    res.json(data);
  } catch (err) {
    console.error('[admin/metrics] failed:', err);
    res.status(500).json({ error: 'metrics failed' });
  }
});

// ── Founder-managed developer API keys ────────────────────────────────────
// Same isFounder gate + 403. STUB: nothing authenticates against these yet (no
// developer API surface exists). We never store or re-return the plaintext
// secret — only its sha256 hash + a short prefix for identification. The secret
// is returned exactly ONCE, at creation.
const toKeyJson = (r) => ({
  id:         r.id,
  name:       r.name,
  prefix:     r.prefix,
  createdAt:  r.created_at  ? new Date(r.created_at).toISOString()  : null,
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  revoked:    r.revoked === true,
});

// GET /admin/api-keys — never includes hashes or secrets.
router.get('/api-keys', requireAuth, requireFounder, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, prefix, created_at, last_used_at, revoked
         FROM api_keys ORDER BY created_at DESC`,
    );
    res.json({ keys: rows.map(toKeyJson) });
  } catch (err) {
    console.error('[admin/api-keys GET] failed:', err);
    res.status(500).json({ error: 'list failed' });
  }
});

// POST /admin/api-keys { name } — mint a key; return the secret ONCE.
router.post('/api-keys', requireAuth, requireFounder, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const secret = generateApiSecret();           // plaintext — returned once, never stored
    const prefix = secret.slice(0, 12);
    const { rows } = await pool.query(
      `INSERT INTO api_keys (name, key_hash, prefix)
       VALUES ($1, $2, $3)
       RETURNING id, name, prefix, created_at, last_used_at, revoked`,
      [name, hashApiKey(secret), prefix],          // only the HASH is persisted
    );
    res.status(201).json({ key: toKeyJson(rows[0]), secret });
  } catch (err) {
    console.error('[admin/api-keys POST] failed:', err);
    res.status(500).json({ error: 'create failed' });
  }
});

// POST /admin/api-keys/:id/revoke — flip revoked; key can never be un-revoked.
router.post('/api-keys/:id/revoke', requireAuth, requireFounder, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE api_keys SET revoked = TRUE WHERE id = $1
       RETURNING id, name, prefix, created_at, last_used_at, revoked`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'key not found' });
    res.json({ key: toKeyJson(rows[0]) });
  } catch (err) {
    console.error('[admin/api-keys revoke] failed:', err);
    res.status(500).json({ error: 'revoke failed' });
  }
});

module.exports = router;
