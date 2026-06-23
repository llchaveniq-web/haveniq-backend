-- ============================================================================
--  cleanup_demo_data.sql — ONE-TIME physical removal of ALL demo/test data.
--  (2026-06-22, real-user launch prep.)
--
--  Deletes both demo flavors and EVERYTHING they reference:
--    • @haveniq-demo.edu  — the seeded demo cohort (sampleNN / maya.r / demoNNN…)
--    • @demo.haveniq.app  — the founder's manual test signups
--
--  WHY THIS IS SAFE: every foreign key to users(id) — across schema.sql,
--  migrate_missing.sql, every migration, and the code-created tables
--  (matched_moments, match_outcomes, feature_state, vouches, telemetry, …) —
--  is ON DELETE CASCADE or ON DELETE SET NULL. So deleting the demo users
--  cascade-removes their compatibility_scores, conversations → messages,
--  quiz_answers, personality/profile snapshots, connect_requests, profile_views,
--  group memberships, etc., and NULLs the audit-log / safety-report references
--  (legal trail survives). No table uses RESTRICT, so nothing blocks.
--
--  NOT TOUCHED: the founder's REAL account (jberney@student.cccd.edu) — it's a
--  real .edu, not a demo domain. Its separate test-account cleaner is
--  cleanup_test_user.sql; this file does not run that.
--
--  RUN ORDER: deploy the DEMO_FEED-gated seeder FIRST (seedDemoMatchable now
--  early-returns unless DEMO_FEED=true). Otherwise the next server boot
--  re-creates the cohort and this cleanup is undone.
--
--  HOW TO RUN: paste this whole file into Railway → Postgres → Data/Query tab.
--  It runs in ONE transaction and prints before/after counts.
--    • To DRY-RUN: change the final `COMMIT;` to `ROLLBACK;` — you'll see the
--      counts with nothing persisted. Re-run with COMMIT when satisfied.
-- ============================================================================

BEGIN;

-- 1. Sanity check — what is about to be deleted.
SELECT
  count(*) FILTER (WHERE email LIKE '%@haveniq-demo.edu') AS seeded_demo_users,
  count(*) FILTER (WHERE email LIKE '%@demo.haveniq.app') AS founder_test_users,
  count(*)                                                 AS total_demo_users
FROM users
WHERE email LIKE '%@haveniq-demo.edu'
   OR email LIKE '%@demo.haveniq.app';

-- 2. The delete. Children cascade automatically (see header).
DELETE FROM users
WHERE email LIKE '%@haveniq-demo.edu'
   OR email LIKE '%@demo.haveniq.app';

-- 3. Proof: zero demo users remain.
SELECT count(*) AS demo_users_remaining
FROM users
WHERE email LIKE '%@haveniq-demo.edu'
   OR email LIKE '%@demo.haveniq.app';

-- 4. Proof: no orphaned conversations linger (cascade should leave 0).
SELECT count(*) AS orphan_conversations
FROM conversations c
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = c.user_a)
   OR NOT EXISTS (SELECT 1 FROM users WHERE id = c.user_b);

-- Change to ROLLBACK to dry-run (see header).
COMMIT;
