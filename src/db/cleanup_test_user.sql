-- ═══════════════════════════════════════════════════════════════
--  HavenIQ — clean up the founder's initial test account so the
--  demo flow starts from a true zero state.
--
--  Run once on Railway Postgres via the Data tab. Cascading FK
--  deletes will automatically remove this user's quiz_answers,
--  push_tokens, profile_views, compatibility_scores, etc.
--
--  After running this, the next time jberney@student.cccd.edu
--  signs up via the app it'll be a fresh account.
-- ═══════════════════════════════════════════════════════════════

DELETE FROM users WHERE email = 'jberney@student.cccd.edu';

-- Verify there's nothing left tied to that email
SELECT 'remaining test rows in users' AS check, COUNT(*) AS count
FROM users WHERE email = 'jberney@student.cccd.edu'
UNION ALL
SELECT 'remaining OTPs for that email', COUNT(*)
FROM otp_codes WHERE email = 'jberney@student.cccd.edu';
