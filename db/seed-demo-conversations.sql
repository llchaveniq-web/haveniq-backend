-- ═══════════════════════════════════════════════════════════════════════════
--  Seed demo conversations for a single account
--  Paste into Railway → Postgres → Data tab.
--  Idempotent: re-running won't duplicate rows.
--
--  HOW TO USE:
--    1. Find the line marked  ⮕  REPLACE_YOUR_EMAIL_HERE  ⮕  below
--    2. Replace it with the literal email you signed up with, e.g.
--         'jane@calpoly.edu'   (keep the single quotes)
--    3. Paste the whole block into Railway's query runner and run
--    4. Open app.haveniq.org → Messages — five conversations now show
--
--  HOW TO REMOVE LATER:
--    DELETE FROM users WHERE email LIKE '%@demo.haveniq.app';
--    (Cascades clean up compatibility_scores, conversations, messages,
--     and connect_requests for the four demo users.)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Insert demo users ───────────────────────────────────────────────────
-- All demo emails end in @demo.haveniq.app so they're easy to identify and
-- delete later. Resend won't deliver to this fake domain, so the demo
-- users will never receive emails. ON CONFLICT DO NOTHING makes this safe
-- to re-run.

INSERT INTO users (email, school, school_domain, first_name, last_name, bio, major, school_year, age, gender, looking_for, budget_min, budget_max, neighborhoods, roommate_status, is_verified, quiz_completed, trust_score)
VALUES
  ('sofia.m@demo.haveniq.app',  'Stanford University',  'stanford.edu',  'Sofia',  'M', 'Architecture student, early riser, very tidy. Looking for someone chill for Palo Alto.',     'Architecture',      'Sophomore', 20, 'Woman', ARRAY['Woman','Non-binary'],       1200, 1800, ARRAY['Palo Alto','Menlo Park'],  'actively_looking', TRUE, TRUE, 78),
  ('tyler.k@demo.haveniq.app',  'UCLA',                 'ucla.edu',      'Tyler',  'K', 'Business analytics + intramural soccer. Sleep early on weekdays, friends over on weekends.',  'Business Analytics', 'Junior',    21, 'Man',   ARRAY['Man','Non-binary'],         900,  1300, ARRAY['Westwood','Brentwood'],    'actively_looking', TRUE, TRUE, 82),
  ('priya.n@demo.haveniq.app',  'UC Berkeley',          'berkeley.edu',  'Priya',  'N', 'CS senior, vegan-leaning, plant person. I need a kitchen I can actually use.',               'Computer Science',  'Senior',    22, 'Woman', ARRAY['Woman','Non-binary'],       1100, 1600, ARRAY['North Berkeley','Albany'], 'actively_looking', TRUE, TRUE, 84),
  ('marcus.l@demo.haveniq.app', 'USC',                  'usc.edu',       'Marcus', 'L', 'Film student, night owl. Looking for someone who doesn''t hate fluorescent light at 2am.',  'Film Production',   'Junior',    21, 'Man',   ARRAY['Man','Woman','Non-binary'], 950,  1400, ARRAY['University Park','DTLA'],  'open_to_offers',   TRUE, TRUE, 76)
ON CONFLICT (email) DO NOTHING;

-- ── 2. Resolve IDs into a temp table ───────────────────────────────────────
-- ⮕ REPLACE_YOUR_EMAIL_HERE ⮕  Change the placeholder on the FIRST line
-- below to your literal sign-up email (keep the single quotes). Everything
-- else below reads from this temp table — no other edits needed.

DROP TABLE IF EXISTS _demo_ids;
CREATE TEMP TABLE _demo_ids AS
SELECT
  (SELECT id FROM users WHERE email = 'jberney@student.cccd.edu')      AS me,
  (SELECT id FROM users WHERE email = 'sofia.m@demo.haveniq.app')     AS sofia,
  (SELECT id FROM users WHERE email = 'tyler.k@demo.haveniq.app')     AS tyler,
  (SELECT id FROM users WHERE email = 'priya.n@demo.haveniq.app')     AS priya,
  (SELECT id FROM users WHERE email = 'marcus.l@demo.haveniq.app')    AS marcus;

-- Abort loudly if the placeholder wasn't replaced or the email doesn't
-- match any row.
DO $$
DECLARE my_id UUID;
BEGIN
  SELECT me INTO my_id FROM _demo_ids;
  IF my_id IS NULL THEN
    RAISE EXCEPTION 'Could not find a user with that email. Did you replace the placeholder on the line marked REPLACE_YOUR_EMAIL_HERE?';
  END IF;
END $$;

-- ── 3. Compatibility scores ────────────────────────────────────────────────
-- /matches/connect requires a row here >= 65 before allowing a connect
-- request. Seed scores in the 86–94 range. user_a < user_b is enforced
-- by a table CHECK, so we order with LEAST/GREATEST.

INSERT INTO compatibility_scores (user_a, user_b, score, breakdown, why_matched)
SELECT LEAST(me, sofia),  GREATEST(me, sofia),  92.00, '{"attachment":95,"communication":91,"lifestyle":88}'::jsonb, 'Same study-first mindset and weekday quiet-hours preference. You both prioritize a clean shared kitchen and early bedtimes.'              FROM _demo_ids
UNION ALL
SELECT LEAST(me, tyler),  GREATEST(me, tyler),  88.00, '{"attachment":86,"communication":92,"lifestyle":85}'::jsonb, 'Direct communicators with overlapping social patterns — weekday focus, weekend openness. Compatible budget bands.'                       FROM _demo_ids
UNION ALL
SELECT LEAST(me, priya),  GREATEST(me, priya),  94.00, '{"attachment":94,"communication":96,"lifestyle":91}'::jsonb, 'Both score high on self-awareness and direct repair after conflict. Aligned cleanliness standards and shared interest in cooking at home.' FROM _demo_ids
UNION ALL
SELECT LEAST(me, marcus), GREATEST(me, marcus), 86.00, '{"attachment":83,"communication":89,"lifestyle":80}'::jsonb, 'Different schedules but mutual respect for personal space. Marcus is a night-owl, you''re flexible — friction-low pair.'                  FROM _demo_ids
ON CONFLICT (user_a, user_b) DO NOTHING;

-- ── 4. Accepted connect requests ───────────────────────────────────────────
-- Marks each demo user as having sent you a request that you accepted —
-- mirrors the live flow that creates conversations.

INSERT INTO connect_requests (from_user, to_user, status, created_at, updated_at)
SELECT sofia,  me, 'accepted', NOW() - INTERVAL '3 days',  NOW() - INTERVAL '3 days'  FROM _demo_ids
UNION ALL
SELECT tyler,  me, 'accepted', NOW() - INTERVAL '2 days',  NOW() - INTERVAL '2 days'  FROM _demo_ids
UNION ALL
SELECT priya,  me, 'accepted', NOW() - INTERVAL '1 day',   NOW() - INTERVAL '1 day'   FROM _demo_ids
UNION ALL
SELECT marcus, me, 'accepted', NOW() - INTERVAL '4 hours', NOW() - INTERVAL '4 hours' FROM _demo_ids
ON CONFLICT (from_user, to_user) DO NOTHING;

-- ── 5. Conversations ───────────────────────────────────────────────────────
-- conversations.user_a < user_b is a CHECK, so use LEAST/GREATEST again.

INSERT INTO conversations (user_a, user_b, created_at)
SELECT LEAST(me, sofia),  GREATEST(me, sofia),  NOW() - INTERVAL '3 days'  FROM _demo_ids
UNION ALL
SELECT LEAST(me, tyler),  GREATEST(me, tyler),  NOW() - INTERVAL '2 days'  FROM _demo_ids
UNION ALL
SELECT LEAST(me, priya),  GREATEST(me, priya),  NOW() - INTERVAL '1 day'   FROM _demo_ids
UNION ALL
SELECT LEAST(me, marcus), GREATEST(me, marcus), NOW() - INTERVAL '4 hours' FROM _demo_ids
ON CONFLICT (user_a, user_b) DO NOTHING;

-- ── 6. Messages ────────────────────────────────────────────────────────────
-- Each thread has 2–4 messages with a realistic back-and-forth. Sender
-- alternates so the conversations look two-sided. Timestamps step forward
-- so the last_message_at ordering is sane (newest at top).

-- Sofia — oldest thread, fully read
WITH conv AS (
  SELECT c.id FROM conversations c, _demo_ids d
  WHERE c.user_a = LEAST(d.me, d.sofia) AND c.user_b = GREATEST(d.me, d.sofia)
)
INSERT INTO messages (conversation_id, sender_id, body, read, created_at)
SELECT conv.id, d.sofia, 'Hey! Saw we matched at 92%. I''m looking at Palo Alto in Aug — are you?', TRUE, NOW() - INTERVAL '3 days'                            FROM conv, _demo_ids d
UNION ALL
SELECT conv.id, d.me,    'Yes! Just started looking. What''s your budget?',                          TRUE, NOW() - INTERVAL '3 days' + INTERVAL '20 minutes'  FROM conv, _demo_ids d
UNION ALL
SELECT conv.id, d.sofia, '$1.4–1.8K depending on the room. Two-bed ideally.',                        TRUE, NOW() - INTERVAL '3 days' + INTERVAL '35 minutes'  FROM conv, _demo_ids d
UNION ALL
SELECT conv.id, d.me,    'Same range. Want to compare lists this weekend?',                          TRUE, NOW() - INTERVAL '2 days' + INTERVAL '10 hours'    FROM conv, _demo_ids d;

-- Tyler — mid thread, one unread from him
WITH conv AS (
  SELECT c.id FROM conversations c, _demo_ids d
  WHERE c.user_a = LEAST(d.me, d.tyler) AND c.user_b = GREATEST(d.me, d.tyler)
)
INSERT INTO messages (conversation_id, sender_id, body, read, created_at)
SELECT conv.id, d.tyler, 'What''s up — saw Westwood was in your prefs too. Looking for Aug or earlier?',                       TRUE,  NOW() - INTERVAL '2 days'                            FROM conv, _demo_ids d
UNION ALL
SELECT conv.id, d.me,    'Aug. You found anything good yet?',                                                                   TRUE,  NOW() - INTERVAL '2 days' + INTERVAL '45 minutes'  FROM conv, _demo_ids d
UNION ALL
SELECT conv.id, d.tyler, 'A few. There''s a 2br off Gayley that''s solid. Want to do a walk-through together?',                FALSE, NOW() - INTERVAL '6 hours'                            FROM conv, _demo_ids d;

-- Priya — newer thread, two unread from her
WITH conv AS (
  SELECT c.id FROM conversations c, _demo_ids d
  WHERE c.user_a = LEAST(d.me, d.priya) AND c.user_b = GREATEST(d.me, d.priya)
)
INSERT INTO messages (conversation_id, sender_id, body, read, created_at)
SELECT conv.id, d.priya, 'Hi! 94% feels real — the breakdown on conflict + cleanliness is wild.',                       FALSE, NOW() - INTERVAL '1 day'                          FROM conv, _demo_ids d
UNION ALL
SELECT conv.id, d.priya, 'Are you cooking-at-home person? I see that''s in your bio — same here.',                     FALSE, NOW() - INTERVAL '1 day' + INTERVAL '12 minutes' FROM conv, _demo_ids d;

-- Marcus — most recent, one unread
WITH conv AS (
  SELECT c.id FROM conversations c, _demo_ids d
  WHERE c.user_a = LEAST(d.me, d.marcus) AND c.user_b = GREATEST(d.me, d.marcus)
)
INSERT INTO messages (conversation_id, sender_id, body, read, created_at)
SELECT conv.id, d.marcus, 'Hey — fellow night-owl I assume? Your bio sounds like you''d be okay with editing at 1am.', FALSE, NOW() - INTERVAL '4 hours' FROM conv, _demo_ids d;

COMMIT;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- Should return 4 demo conversations + your real Maya R one = 5 total.
SELECT
  u.first_name || ' ' || COALESCE(u.last_name,'') AS other,
  m.body AS last_message,
  m.created_at AS sent_at
FROM conversations c
JOIN messages m ON m.conversation_id = c.id
JOIN users u ON u.id = CASE WHEN c.user_a = (SELECT id FROM users WHERE email = 'jberney@student.cccd.edu') THEN c.user_b ELSE c.user_a END
WHERE c.user_a = (SELECT id FROM users WHERE email = 'jberney@student.cccd.edu')
   OR c.user_b = (SELECT id FROM users WHERE email = 'jberney@student.cccd.edu')
ORDER BY m.created_at DESC
LIMIT 20;
