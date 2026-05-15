-- ═══════════════════════════════════════════════════════════════
--  HavenIQ — seed 10 demo users so the match feed isn't empty
--  Run once on Railway Postgres via the Data tab.
--  Idempotent: ON CONFLICT (email) DO NOTHING means repeated runs
--  won't duplicate rows.
--
--  Each seed user has:
--    • A real-looking name, school, major, age, bio
--    • A complete quiz answer set (50 of the 60 questions, varied
--      enough across the 10 users that compatibility scores spread)
--    • is_verified=TRUE so they show in the verified feed
--    • A placeholder photo_url; replace with real Cloudinary URLs
--      once you have them, or leave as is and clients fall back to
--      initials.
--
--  Delete with:  DELETE FROM users WHERE email LIKE '%@haveniq-demo.edu';
-- ═══════════════════════════════════════════════════════════════

-- ── Insert demo users ──────────────────────────────────────────────────
INSERT INTO users (
  email, school, school_domain, first_name, last_name,
  bio, major, school_year, age, gender, looking_for,
  budget_min, budget_max, move_in_timeline, neighborhoods,
  roommate_status, is_verified, quiz_completed, trust_score
) VALUES
  ('maya.r@haveniq-demo.edu',     'UCLA',                       'ucla.edu',
   'Maya', 'R',
   'Quiet bookworm, early riser, big fan of meal prep Sundays. Hoping to find someone equally tidy.',
   'Psychology', 'Junior', 20, 'Woman', ARRAY['Woman'],
   900, 1500, '1 month', ARRAY['Westwood','Mar Vista'],
   'actively_looking', TRUE, TRUE, 75),

  ('jamie.l@haveniq-demo.edu',    'UC Berkeley',                'berkeley.edu',
   'Jamie', 'L',
   'Engineering student, late-night coder, but quiet about it. Coffee snob, dog person.',
   'Computer Science', 'Senior', 22, 'Non-binary', ARRAY['Man','Woman','Non-binary'],
   1100, 1800, '2 months', ARRAY['North Berkeley','Downtown Berkeley'],
   'actively_looking', TRUE, TRUE, 80),

  ('alex.p@haveniq-demo.edu',     'Stanford University',        'stanford.edu',
   'Alex', 'P',
   'Pre-med, runner, mostly chill. Love a clean kitchen but I''m not a neat freak about everything.',
   'Biology', 'Sophomore', 19, 'Man', ARRAY['Woman'],
   1000, 1700, '1 month', ARRAY['Palo Alto','Menlo Park'],
   'open_to_offers', TRUE, TRUE, 70),

  ('priya.s@haveniq-demo.edu',    'USC',                        'usc.edu',
   'Priya', 'S',
   'Film major, night owl, will absolutely watch a 3-hour Tarkovsky movie with you. Spotify recs welcome.',
   'Film & Television', 'Junior', 21, 'Woman', ARRAY['Man','Woman','Non-binary'],
   1300, 2000, '2 months', ARRAY['Koreatown','Silver Lake'],
   'actively_looking', TRUE, TRUE, 78),

  ('marcus.b@haveniq-demo.edu',   'UC San Diego',               'ucsd.edu',
   'Marcus', 'B',
   'Marine bio, surfer, mostly outdoors. Looking for someone who won''t mind a wetsuit drying on the balcony.',
   'Marine Biology', 'Senior', 22, 'Man', ARRAY['Man'],
   800, 1400, '1 month', ARRAY['La Jolla','Pacific Beach'],
   'actively_looking', TRUE, TRUE, 72),

  ('sara.n@haveniq-demo.edu',     'California State University, Long Beach', 'csulb.edu',
   'Sara', 'N',
   'Nursing student, big plant collection, very into Sunday family-style dinners with roommates.',
   'Nursing', 'Sophomore', 20, 'Woman', ARRAY['Woman','Non-binary'],
   700, 1200, '2 months', ARRAY['Belmont Shore','Bixby Knolls'],
   'actively_looking', TRUE, TRUE, 82),

  ('diego.m@haveniq-demo.edu',    'UC Irvine',                  'uci.edu',
   'Diego', 'M',
   'Econ major, gym-rat vibe, surprisingly emotional about Pixar movies. Looking for a chill roommate.',
   'Economics', 'Junior', 21, 'Man', ARRAY['Woman'],
   950, 1600, '1 month', ARRAY['University Park','Woodbridge'],
   'open_to_offers', TRUE, TRUE, 68),

  ('emma.w@haveniq-demo.edu',     'UC Santa Barbara',           'ucsb.edu',
   'Emma', 'W',
   'Environmental science, vegan-curious, weekend hiker. Will absolutely fight you over the thermostat.',
   'Environmental Studies', 'Junior', 20, 'Woman', ARRAY['Man','Woman'],
   1000, 1500, '2 months', ARRAY['Isla Vista','Goleta'],
   'actively_looking', TRUE, TRUE, 74),

  ('noah.k@haveniq-demo.edu',     'Cal Poly San Luis Obispo',   'calpoly.edu',
   'Noah', 'K',
   'Mechanical engineering, board games nerd, generally messy at my desk but tidy in shared spaces.',
   'Mechanical Engineering', 'Sophomore', 19, 'Man', ARRAY['Man','Woman','Non-binary'],
   850, 1400, '1 month', ARRAY['Downtown SLO','Foothill'],
   'open_to_offers', TRUE, TRUE, 69),

  ('lily.c@haveniq-demo.edu',     'UC Davis',                   'ucdavis.edu',
   'Lily', 'C',
   'Vet science, two cats already (bringing them), morning person, never raises voice even in arguments.',
   'Animal Science', 'Senior', 22, 'Woman', ARRAY['Woman'],
   900, 1400, '2 months', ARRAY['Downtown Davis','South Davis'],
   'actively_looking', TRUE, TRUE, 85)
ON CONFLICT (email) DO NOTHING;

-- ── Insert varied quiz answers for each demo user ──────────────────────
-- The shape is { "1": option_index, "2": option_index, ... } for the first
-- 50 questions. Different users have different answer signatures so
-- compatibility scores will distribute (not everyone matches 99%).

INSERT INTO quiz_answers (user_id, answers, completed)
SELECT u.id, q.answers::jsonb, TRUE
FROM (VALUES
  ('maya.r@haveniq-demo.edu',
   '{"1":0,"2":0,"3":3,"4":0,"5":1,"6":0,"7":3,"8":0,"9":2,"10":0,"11":0,"12":2,"13":0,"14":1,"15":0,"16":0,"17":0,"18":2,"19":1,"20":0,"21":1,"22":1,"26":0,"27":2,"28":1,"29":1,"30":0,"31":0,"32":0,"33":0,"34":0,"35":0,"36":0,"37":0,"38":1,"39":0,"40":0,"41":1,"42":0,"43":0,"44":0,"45":0,"46":0,"47":0,"48":1,"49":0,"50":1,"51":0,"52":1,"53":1,"54":1,"55":1}'),
  ('jamie.l@haveniq-demo.edu',
   '{"1":0,"2":1,"3":2,"4":1,"5":1,"6":2,"7":2,"8":2,"9":1,"10":1,"11":1,"12":1,"13":1,"14":0,"15":1,"16":2,"17":1,"18":2,"19":1,"20":1,"21":2,"22":2,"26":1,"27":2,"28":0,"29":0,"30":1,"31":0,"32":0,"33":0,"34":0,"35":0,"36":1,"37":1,"38":1,"39":1,"40":0,"41":1,"42":0,"43":0,"44":0,"45":1,"46":0,"47":0,"48":2,"49":3,"50":2,"51":1,"52":1,"53":2,"54":2,"55":2}'),
  ('alex.p@haveniq-demo.edu',
   '{"1":0,"2":0,"3":1,"4":0,"5":1,"6":0,"7":2,"8":2,"9":2,"10":0,"11":1,"12":1,"13":1,"14":1,"15":1,"16":0,"17":0,"18":1,"19":1,"20":1,"21":1,"22":1,"26":1,"27":2,"28":2,"29":1,"30":0,"31":0,"32":0,"33":0,"34":0,"35":0,"36":0,"37":0,"38":0,"39":0,"40":0,"41":0,"42":0,"43":0,"44":0,"45":0,"46":1,"47":0,"48":1,"49":1,"50":1,"51":1,"52":2,"53":1,"54":1,"55":2}'),
  ('priya.s@haveniq-demo.edu',
   '{"1":0,"2":0,"3":3,"4":0,"5":2,"6":1,"7":1,"8":1,"9":1,"10":2,"11":2,"12":1,"13":2,"14":1,"15":2,"16":1,"17":1,"18":1,"19":2,"20":2,"21":0,"22":0,"26":1,"27":1,"28":1,"29":2,"30":1,"31":0,"32":0,"33":0,"34":0,"35":0,"36":1,"37":1,"38":1,"39":1,"40":1,"41":1,"42":1,"43":0,"44":0,"45":1,"46":1,"47":1,"48":2,"49":3,"50":2,"51":2,"52":1,"53":2,"54":1,"55":2}'),
  ('marcus.b@haveniq-demo.edu',
   '{"1":2,"2":1,"3":0,"4":1,"5":2,"6":2,"7":2,"8":0,"9":1,"10":1,"11":2,"12":0,"13":2,"14":0,"15":2,"16":2,"17":2,"18":0,"19":2,"20":2,"21":2,"22":2,"26":2,"27":2,"28":2,"29":2,"30":2,"31":0,"32":0,"33":0,"34":0,"35":0,"36":0,"37":1,"38":1,"39":0,"40":0,"41":0,"42":0,"43":0,"44":0,"45":1,"46":0,"47":0,"48":1,"49":1,"50":0,"51":1,"52":2,"53":2,"54":2,"55":0}'),
  ('sara.n@haveniq-demo.edu',
   '{"1":0,"2":0,"3":3,"4":0,"5":0,"6":0,"7":0,"8":1,"9":2,"10":0,"11":0,"12":2,"13":0,"14":2,"15":0,"16":0,"17":0,"18":0,"19":0,"20":0,"21":1,"22":0,"26":0,"27":1,"28":2,"29":2,"30":0,"31":0,"32":0,"33":0,"34":0,"35":0,"36":0,"37":0,"38":0,"39":0,"40":0,"41":0,"42":0,"43":0,"44":0,"45":0,"46":0,"47":0,"48":1,"49":0,"50":0,"51":0,"52":0,"53":0,"54":0,"55":1}'),
  ('diego.m@haveniq-demo.edu',
   '{"1":1,"2":1,"3":1,"4":1,"5":1,"6":2,"7":1,"8":2,"9":1,"10":1,"11":1,"12":1,"13":2,"14":1,"15":1,"16":1,"17":1,"18":2,"19":1,"20":1,"21":1,"22":1,"26":1,"27":2,"28":1,"29":1,"30":1,"31":0,"32":0,"33":0,"34":0,"35":0,"36":1,"37":1,"38":1,"39":1,"40":1,"41":1,"42":0,"43":0,"44":0,"45":1,"46":1,"47":0,"48":2,"49":2,"50":1,"51":1,"52":1,"53":1,"54":1,"55":1}'),
  ('emma.w@haveniq-demo.edu',
   '{"1":0,"2":0,"3":3,"4":0,"5":1,"6":0,"7":0,"8":1,"9":2,"10":1,"11":1,"12":2,"13":1,"14":2,"15":1,"16":0,"17":1,"18":0,"19":1,"20":1,"21":0,"22":1,"26":0,"27":1,"28":1,"29":2,"30":1,"31":0,"32":0,"33":0,"34":0,"35":0,"36":1,"37":0,"38":1,"39":1,"40":0,"41":1,"42":0,"43":0,"44":0,"45":1,"46":0,"47":0,"48":1,"49":1,"50":1,"51":1,"52":1,"53":1,"54":1,"55":2}'),
  ('noah.k@haveniq-demo.edu',
   '{"1":1,"2":1,"3":1,"4":1,"5":1,"6":1,"7":1,"8":2,"9":1,"10":0,"11":2,"12":1,"13":2,"14":2,"15":2,"16":1,"17":1,"18":2,"19":1,"20":1,"21":1,"22":1,"26":1,"27":2,"28":1,"29":1,"30":1,"31":0,"32":0,"33":0,"34":0,"35":0,"36":1,"37":1,"38":1,"39":1,"40":1,"41":1,"42":0,"43":0,"44":0,"45":1,"46":1,"47":0,"48":2,"49":2,"50":1,"51":1,"52":2,"53":1,"54":1,"55":2}'),
  ('lily.c@haveniq-demo.edu',
   '{"1":0,"2":0,"3":3,"4":0,"5":0,"6":0,"7":3,"8":0,"9":2,"10":0,"11":0,"12":2,"13":0,"14":2,"15":0,"16":0,"17":0,"18":2,"19":0,"20":0,"21":1,"22":1,"26":0,"27":1,"28":2,"29":1,"30":0,"31":0,"32":0,"33":0,"34":0,"35":0,"36":0,"37":0,"38":0,"39":0,"40":0,"41":0,"42":0,"43":0,"44":0,"45":0,"46":0,"47":0,"48":1,"49":0,"50":0,"51":0,"52":1,"53":1,"54":1,"55":1}')
) AS q(email, answers)
JOIN users u ON u.email = q.email
ON CONFLICT (user_id) DO UPDATE
  SET answers = EXCLUDED.answers, completed = TRUE, updated_at = NOW();
