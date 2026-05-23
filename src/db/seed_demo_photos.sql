-- ═══════════════════════════════════════════════════════════════
--  HavenIQ — give the demo seed users college-aged placeholder photos.
--  Run once on Railway Postgres via the Data tab.
--
--  Scoped strictly to @haveniq-demo.edu accounts — fictional seed
--  users (see seed_demo_users.sql), shown only to founders for
--  investor demos. Real students never see demo users (the
--  /matches/feed demo filter hides them), so this never puts a fake
--  face in front of a real user.
--
--  Photo set: hand-picked pravatar portraits that read as ~18-22
--  (college-aged) and roughly match each profile's gender.
--
--  Real students' photos come from their own profile uploads once
--  the Cloudinary env vars are set on Railway.
-- ═══════════════════════════════════════════════════════════════

UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=5'  WHERE email = 'maya.r@haveniq-demo.edu';
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=48' WHERE email = 'jamie.l@haveniq-demo.edu';
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=12' WHERE email = 'alex.p@haveniq-demo.edu';
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=23' WHERE email = 'priya.s@haveniq-demo.edu';
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=60' WHERE email = 'marcus.b@haveniq-demo.edu';
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=44' WHERE email = 'sara.n@haveniq-demo.edu';
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=8'  WHERE email = 'diego.m@haveniq-demo.edu';
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=16' WHERE email = 'emma.w@haveniq-demo.edu';
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=59' WHERE email = 'noah.k@haveniq-demo.edu';
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=26' WHERE email = 'lily.c@haveniq-demo.edu';

-- Any other demo account (e.g. an 11th seed user) — generic young
-- portrait, won't overwrite the 10 matched above.
UPDATE users SET photo_url = 'https://i.pravatar.cc/512?img=27'
WHERE email LIKE '%@haveniq-demo.edu'
  AND email NOT IN (
    'maya.r@haveniq-demo.edu','jamie.l@haveniq-demo.edu','alex.p@haveniq-demo.edu',
    'priya.s@haveniq-demo.edu','marcus.b@haveniq-demo.edu','sara.n@haveniq-demo.edu',
    'diego.m@haveniq-demo.edu','emma.w@haveniq-demo.edu','noah.k@haveniq-demo.edu',
    'lily.c@haveniq-demo.edu'
  );
