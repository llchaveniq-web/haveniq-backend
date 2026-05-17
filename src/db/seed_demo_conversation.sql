-- ═══════════════════════════════════════════════════════════════
--  HavenIQ — seed a demo conversation so the Messages tab isn't
--  empty during investor demos.
--
--  HOW TO USE:
--    1. Sign up in the app first.
--    2. Replace 'YOUR_EMAIL_HERE' below with your actual .edu address.
--    3. Paste into Railway → Postgres → Data tab → Run.
--
--  Result: 3 messages from Maya R appear in your Messages tab as if
--  she reached out after seeing your profile. Tapping the thread
--  opens a real chat UI you can scroll.
--
--  Idempotent: the conversation insert uses ON CONFLICT DO NOTHING,
--  so re-running just adds more messages (which is fine — make the
--  inbox feel even more alive).
--
--  Cleanup (if you ever want to remove):
--    DELETE FROM conversations
--    WHERE (user_a IN (SELECT id FROM users WHERE email = 'YOUR_EMAIL_HERE')
--        OR user_b IN (SELECT id FROM users WHERE email = 'YOUR_EMAIL_HERE'))
--      AND (user_a IN (SELECT id FROM users WHERE email LIKE '%@haveniq-demo.edu')
--        OR user_b IN (SELECT id FROM users WHERE email LIKE '%@haveniq-demo.edu'));
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  my_id    UUID;
  maya_id  UUID;
  conv_id  UUID;
BEGIN
  -- Find both users
  SELECT id INTO my_id   FROM users WHERE email = 'YOUR_EMAIL_HERE';
  SELECT id INTO maya_id FROM users WHERE email = 'maya.r@haveniq-demo.edu';

  IF my_id IS NULL THEN
    RAISE EXCEPTION 'No user found with that email. Did you sign up first? Edit the email in this script.';
  END IF;
  IF maya_id IS NULL THEN
    RAISE EXCEPTION 'Demo user maya.r@haveniq-demo.edu not found. Run seed_demo_users.sql first.';
  END IF;

  -- Find or create the conversation (canonical ordering required by CHECK constraint)
  INSERT INTO conversations (user_a, user_b)
  VALUES (LEAST(my_id, maya_id), GREATEST(my_id, maya_id))
  ON CONFLICT (user_a, user_b) DO NOTHING;

  SELECT id INTO conv_id FROM conversations
  WHERE user_a = LEAST(my_id, maya_id) AND user_b = GREATEST(my_id, maya_id);

  -- Insert 3 messages from Maya, staggered over the last ~20 minutes
  INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES
    (conv_id, maya_id,
     'Hey! Just saw your profile — we matched at like 94% which is wild. Are you actually moving in for fall?',
     NOW() - INTERVAL '18 minutes'),
    (conv_id, maya_id,
     'Also obsessed we both said yes to early riser + clean kitchen. Roommate from last year was a 3am chef 😩',
     NOW() - INTERVAL '11 minutes'),
    (conv_id, maya_id,
     'Coffee sometime to see if vibes actually match in person? No pressure — happy to keep it chat-only first.',
     NOW() - INTERVAL '4 minutes');

  -- Bonus: also seed a connect request from Jamie so the matches tab
  -- has an inbox item too. Same idempotency principle.
  INSERT INTO connect_requests (from_user, to_user, status)
  SELECT id, my_id, 'pending'
  FROM users WHERE email = 'jamie.l@haveniq-demo.edu'
  ON CONFLICT (from_user, to_user) DO NOTHING;

  RAISE NOTICE 'Seeded conversation % with maya_id %', conv_id, maya_id;
END $$;
