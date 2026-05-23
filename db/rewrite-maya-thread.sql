-- ═══════════════════════════════════════════════════════════════════════════
--  Rewrite the Maya R conversation into a believable two-sided thread
--  Paste into Railway → Postgres → Data tab.
--
--  HOW TO USE:
--    1. Find the line marked  ⮕  REPLACE_YOUR_EMAIL_HERE  ⮕  below
--    2. Replace it with the literal email you signed up with, e.g.
--         'jane@calpoly.edu'   (keep the single quotes)
--    3. Paste + run
--
--  WHAT IT DOES:
--    - Finds Maya R (first_name='Maya', last_name starts with 'R')
--    - Finds your conversation with her
--    - DELETES all existing messages in that conversation
--    - INSERTS 14 curated messages alternating between Maya and you,
--      spanning ~26 hours with a natural arc: matched → vibing →
--      proposing coffee → confirming a time
--
--  Safe to re-run — each run resets the thread to this canonical form.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Resolve IDs ─────────────────────────────────────────────────────────
-- ⮕ REPLACE_YOUR_EMAIL_HERE ⮕  Change this placeholder to your sign-up email.

DROP TABLE IF EXISTS _ids;
CREATE TEMP TABLE _ids AS
SELECT
  (SELECT id FROM users WHERE email = 'jberney@student.cccd.edu')                                              AS me,
  (SELECT id FROM users WHERE first_name = 'Maya' AND last_name LIKE 'R%' ORDER BY created_at LIMIT 1)        AS maya,
  (SELECT c.id FROM conversations c, users me, users mr
     WHERE me.email = 'jberney@student.cccd.edu'
       AND mr.first_name = 'Maya' AND mr.last_name LIKE 'R%'
       AND ((c.user_a = me.id AND c.user_b = mr.id) OR (c.user_a = mr.id AND c.user_b = me.id))
     LIMIT 1)                                                                                                  AS conv;

-- Sanity check — bail out loudly if any of the three didn't resolve.
DO $$
DECLARE my_id UUID; maya_id UUID; conv_id UUID;
BEGIN
  SELECT me, maya, conv INTO my_id, maya_id, conv_id FROM _ids;
  IF my_id IS NULL THEN
    RAISE EXCEPTION 'No user matched the email you put on the REPLACE_YOUR_EMAIL_HERE line. Edit it and re-run.';
  END IF;
  IF maya_id IS NULL THEN
    RAISE EXCEPTION 'No Maya R user found (first_name=Maya, last_name LIKE R%). Seed her first.';
  END IF;
  IF conv_id IS NULL THEN
    RAISE EXCEPTION 'No conversation found between you and Maya R. Create one (accept her connect request) before running this.';
  END IF;
END $$;

-- ── 2. Clear the existing thread ──────────────────────────────────────────
DELETE FROM messages WHERE conversation_id = (SELECT conv FROM _ids);

-- ── 3. Insert the curated thread ──────────────────────────────────────────
-- Timeline: 26 hours ago → 30 minutes ago. Alternates sides. Ends on Maya's
-- "see you saturday" so the last bubble is on the left in the screenshot
-- (matches the existing UI pattern). All "me" messages are read=TRUE; the
-- most recent two from Maya are unread so the badge shows on the messages
-- tab.

INSERT INTO messages (conversation_id, sender_id, body, read, created_at)
SELECT conv, maya, 'Heyyy okay 94% — that''s wild. I''ve been reading the breakdown 😂',                              TRUE,  NOW() - INTERVAL '26 hours' FROM _ids UNION ALL
SELECT conv, me,   'Same! I literally read mine three times. The attachment + communication overlap was a lot.',     TRUE,  NOW() - INTERVAL '25 hours' + INTERVAL '40 minutes' FROM _ids UNION ALL
SELECT conv, maya, 'Yeah the conflict-resolution one floored me. I''ve had two bad roommates in a row over that exact thing.',    TRUE,  NOW() - INTERVAL '25 hours' FROM _ids UNION ALL
SELECT conv, me,   'Oof. Same story, honestly. That''s part of why I''m doing this instead of relisting on Craigslist.',          TRUE,  NOW() - INTERVAL '24 hours' + INTERVAL '50 minutes' FROM _ids UNION ALL
SELECT conv, maya, 'How''s your weekday schedule? I''m up at 6, gym by 7, lab by 9. Asleep by 11. Wild I know 🥲',               TRUE,  NOW() - INTERVAL '23 hours' FROM _ids UNION ALL
SELECT conv, me,   'Honestly that maps to mine almost exactly. I''m a 6:30 wake / 10:30 sleep person on weeknights.',            TRUE,  NOW() - INTERVAL '22 hours' + INTERVAL '40 minutes' FROM _ids UNION ALL
SELECT conv, maya, 'Also obsessed we both said yes to early-riser + clean kitchen. Last year''s roommate was a 3am chef 😩',     TRUE,  NOW() - INTERVAL '14 hours' + INTERVAL '20 minutes' FROM _ids UNION ALL
SELECT conv, me,   'Nooo. The 3am stir-fry roommate is a whole genre.',                                                          TRUE,  NOW() - INTERVAL '14 hours' FROM _ids UNION ALL
SELECT conv, maya, 'Lol it really is. Coffee sometime to see if vibes actually match in person? Happy to keep it chat-only first.', TRUE,  NOW() - INTERVAL '13 hours' + INTERVAL '15 minutes' FROM _ids UNION ALL
SELECT conv, me,   'Yes — Saturday morning works? There''s a spot on Telegraph I''ve been wanting to try.',                      TRUE,  NOW() - INTERVAL '12 hours' FROM _ids UNION ALL
SELECT conv, maya, 'Sat is perfect. 10? I''ll be the one in the yellow hoodie + obvious nervousness 😅',                         TRUE,  NOW() - INTERVAL '11 hours' FROM _ids UNION ALL
SELECT conv, me,   '10 it is. I''ll bring our compatibility breakdown printed out for laughs',                                   TRUE,  NOW() - INTERVAL '10 hours' + INTERVAL '20 minutes' FROM _ids UNION ALL
SELECT conv, maya, 'Stop that''s amazing, please do',                                                                            FALSE, NOW() - INTERVAL '40 minutes' FROM _ids UNION ALL
SELECT conv, maya, 'Also — if Saturday goes well, want to look at that 2br off Channing together?',                              FALSE, NOW() - INTERVAL '30 minutes' FROM _ids;

COMMIT;

-- ── Verify ─────────────────────────────────────────────────────────────────
SELECT
  CASE WHEN sender_id = (SELECT id FROM users WHERE email = 'jberney@student.cccd.edu') THEN 'me' ELSE 'Maya' END AS who,
  body,
  to_char(created_at, 'Mon DD HH24:MI') AS sent,
  read
FROM messages
WHERE conversation_id = (
  SELECT c.id FROM conversations c, users me, users mr
   WHERE me.email = 'jberney@student.cccd.edu'
     AND mr.first_name = 'Maya' AND mr.last_name LIKE 'R%'
     AND ((c.user_a = me.id AND c.user_b = mr.id) OR (c.user_a = mr.id AND c.user_b = me.id))
   LIMIT 1
)
ORDER BY created_at;
