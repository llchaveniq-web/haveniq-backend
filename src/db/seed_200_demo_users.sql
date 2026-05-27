-- ═══════════════════════════════════════════════════════════════
--  HavenIQ — generate 200 varied demo users in a single statement.
--
--  Why: gives the founder a realistically-populated matches feed for
--  investor demos + school sales conversations + algorithm spot-checks,
--  without polluting real students' feeds (the @haveniq-demo.edu gate
--  on /matches/feed filters these out for non-founder users).
--
--  How: a CTE builds varied attributes per row using generate_series +
--  modular math against fixed-length arrays of names/schools/bios. The
--  result is 200 INSERTs in one transaction, idempotent via
--  ON CONFLICT (email) DO NOTHING (re-running won't duplicate).
--
--  Run once on Railway → Postgres → Query. Takes <2 seconds.
--
--  Delete with:  DELETE FROM users WHERE email LIKE '%@haveniq-demo.edu';
-- ═══════════════════════════════════════════════════════════════

WITH varied AS (
  SELECT
    n,
    -- First names — 30 deep so each "cohort" of 30 has unique names; with
    -- 200 rows that's ~7 reuses per name spread across different schools/
    -- years, which reads as a realistically-sized college demographic.
    (ARRAY[
      'Aisha','Maya','Jordan','Sam','Priya','Olivia','Riley','Alex','Morgan','Casey',
      'Sofia','Noah','Emma','Liam','Ava','Ethan','Isabella','Mason','Mia','Lucas',
      'Charlotte','Logan','Amelia','Oliver','Harper','Elijah','Evelyn','Carter','Aria','Sebastian'
    ])[1 + (n - 1) % 30]                                                    AS first_name,
    -- Last initials — 26 letters cycling so two "Jacksons" never share
    -- the same last initial in adjacent rows.
    chr(65 + ((n - 1) % 26))::TEXT                                          AS last_initial,
    -- Schools — 8 California-first per the curated list, cycling so
    -- each school gets ~25 demo users on a 200-row run.
    (ARRAY[
      'UC Berkeley','UCLA','USC','Stanford',
      'Cal Poly SLO','UC San Diego','UC Irvine','San Diego State'
    ])[1 + (n - 1) % 8]                                                     AS school,
    (ARRAY[
      'berkeley.edu','ucla.edu','usc.edu','stanford.edu',
      'calpoly.edu','ucsd.edu','uci.edu','sdsu.edu'
    ])[1 + (n - 1) % 8]                                                     AS school_domain,
    -- School year — weighted toward sophomore/junior since that's the
    -- realistic peak roommate-hunting demographic.
    (ARRAY['Freshman','Sophomore','Sophomore','Junior','Junior','Senior'])[1 + (n - 1) % 6]
                                                                            AS school_year,
    -- Ages — 18 to 23, even spread.
    18 + (n % 6)                                                            AS age,
    -- Majors — 10-deep, cycled so each major gets ~20 students.
    (ARRAY[
      'Psychology','Computer Science','Biology','Business','English',
      'Engineering','Communications','Economics','Art History','Political Science'
    ])[1 + (n - 1) % 10]                                                    AS major,
    -- Gender + lookingFor — varied across the row index so the feed
    -- has a mix of identities (avoids "all the demos are women" which
    -- breaks investor-demo realism instantly).
    (ARRAY['Woman','Man','Woman','Man','Nonbinary','Woman','Man'])[1 + (n - 1) % 7]
                                                                            AS gender,
    -- Bios — 12-deep, randomly cycled. Each one is intentionally
    -- specific (Chad's "specific beats generic" pattern) so the matches
    -- screen looks lived-in, not template-y.
    (ARRAY[
      'Early riser, lots of coffee, library is my second home. Looking for someone tidy who respects quiet study time.',
      'Night owl — I do my best work after 11pm. Promise to be quiet when you''re sleeping. Big fan of meal-prep Sundays.',
      'Pre-med, so my schedule''s intense. Need someone who gets that and doesn''t take it personally when I''m buried in books.',
      'Love hosting small dinners, hate big parties at home. Looking for someone with a similar energy.',
      'I''m a chaos-good kind of clean — surfaces are tidy, my desk is a wreck. Honesty about how you actually live > pretending.',
      'Cross-country runner, so up at 6am most days. Bed by 10pm. If you''re a night owl we''ll need to negotiate.',
      'Art major, so my room often has supplies everywhere. Communal spaces stay clean though. Promise.',
      'Quiet, low-maintenance, and I don''t need to be best friends — just respectful roommates who get the basics right.',
      'Love cooking, hate cleaning dishes. If you''re the opposite this is a match made in heaven.',
      'I''m a planner — I''d rather over-communicate than guess. Looking for someone who''s on the same page.',
      'Music major, mostly headphones, occasionally need to practice out loud. Will warn you. Will not surprise you.',
      'Engineering, lots of group projects on Zoom. Decent at chores, terrible at remembering to take out the trash. Working on it.'
    ])[1 + (n - 1) % 12]                                                    AS bio,
    -- Budget range — varied by 50-step buckets so it reads as a realistic
    -- spread, not all the same number.
    700 + ((n % 8) * 100)                                                   AS budget_min,
    1100 + ((n % 6) * 200)                                                  AS budget_max,
    -- Move-in timeline — biased toward fall semester for college realism.
    (ARRAY['this_month','1-3_months','fall_semester','fall_semester','spring_semester','flexible'])[1 + (n - 1) % 6]
                                                                            AS move_in_timeline
  FROM generate_series(1, 200) AS n
)
INSERT INTO users (
  email, school, school_domain, first_name, last_name,
  bio, major, school_year, age, gender, looking_for,
  budget_min, budget_max, move_in_timeline, neighborhoods,
  roommate_status, is_verified, quiz_completed, trust_score
)
SELECT
  -- Sequential demo emails so it's easy to spot + delete demos later.
  'demo' || lpad(n::TEXT, 3, '0') || '@haveniq-demo.edu',
  school, school_domain, first_name, last_initial,
  bio, major, school_year, age, gender,
  -- Looking-for — Woman → looking for Women + Men (broad), Man → same,
  -- Nonbinary → broad. Realistic college distribution.
  CASE gender
    WHEN 'Nonbinary' THEN ARRAY['Woman','Man','Nonbinary']
    ELSE ARRAY['Woman','Man','Nonbinary']
  END,
  budget_min, budget_max, move_in_timeline,
  -- Empty neighborhoods array; not high-signal for demos.
  ARRAY[]::TEXT[],
  'searching',
  TRUE,         -- is_verified — demos all pre-verified so they show in
                -- the verified feed without the founder-review step.
  TRUE,         -- quiz_completed — flips the matching engine on for
                -- these users. Combined with the random-quiz-answer
                -- block below, this gives realistic compatibility
                -- score spread on the matches feed.
  85            -- trust_score — high, since they're "demo" verified.
FROM varied
ON CONFLICT (email) DO NOTHING;

-- ─── Seed varied quiz answers for the new demos ─────────────────────────
--
-- Without this, all 200 demos have NULL personality dimensions and the
-- matching engine returns the same default score for every pair. Each
-- demo gets a randomized answer set across the 9 dealbreaker dimensions
-- so compatibility scores spread realistically.
--
-- user_profile_snapshot is the "denormalized recent quiz state" table —
-- we write directly here rather than going through /quiz/submit so we
-- don't fire 200 derivePersonality() AI calls (which would cost real
-- Anthropic tokens). Demos can have NULL mbti/disc; the matching engine
-- handles that gracefully and falls back to the dimension scores.
INSERT INTO user_profile_snapshot (
  user_id, cleanliness, sleep, noise, guests, alcohol,
  pets, money, communication, space
)
SELECT
  u.id,
  (ARRAY['Very tidy','Tidy','Average','Relaxed'])[1 + (random() * 3)::INT],
  (ARRAY['Early bird (before 10pm)','Night owl (after midnight)','Flexible'])[1 + (random() * 2)::INT],
  (ARRAY['Very quiet','Quiet','Moderate','Lively'])[1 + (random() * 3)::INT],
  (ARRAY['Rarely','Occasionally','Frequently'])[1 + (random() * 2)::INT],
  (ARRAY['Never','Occasionally','Regularly'])[1 + (random() * 2)::INT],
  (ARRAY['No pets','Pet-friendly','Allergic'])[1 + (random() * 2)::INT],
  (ARRAY['Split evenly','Track everything','Flexible'])[1 + (random() * 2)::INT],
  (ARRAY['Direct','Indirect','Mixed'])[1 + (random() * 2)::INT],
  (ARRAY['Need lots of space','Some space','Social'])[1 + (random() * 2)::INT]
FROM users u
WHERE u.email LIKE 'demo%@haveniq-demo.edu'
ON CONFLICT (user_id) DO NOTHING;

-- ─── Summary count for sanity-checking the run ──────────────────────────
SELECT
  COUNT(*) FILTER (WHERE email LIKE 'demo%@haveniq-demo.edu')  AS demo_users_total,
  COUNT(DISTINCT school) FILTER (WHERE email LIKE 'demo%@haveniq-demo.edu') AS demo_schools,
  COUNT(*) FILTER (WHERE email LIKE 'demo%@haveniq-demo.edu' AND is_verified) AS demo_verified
FROM users;
