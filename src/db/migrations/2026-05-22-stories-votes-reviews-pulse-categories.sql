-- ═══════════════════════════════════════════════════════════════
--  Migration: 2026-05-22 cross-user content tables + pulse categories
--
--  Adds:
--    • stories                  — first-person posts (HavenIQ Stories,
--                                 Roommate Stories screens)
--    • best_roommate_votes      — vote tallies for the Best Roommate
--                                 Award screen
--    • building_reviews_shared  — cross-user-visible building reviews
--    • landlord_reviews_shared  — cross-user-visible landlord reviews
--    • match_pulses.* columns   — per-category check-in scores
--                                 (Communication / Chores / Noise / Respect)
--
--  Apply via Railway → Postgres → Data tab. Multi-statement DDL works.
--  IF NOT EXISTS / IF NOT EXISTS COLUMN means this is safe to re-run.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ── Stories ─────────────────────────────────────────────────────────────
-- One row per posted story. `author_id` is nullable so anonymous posts
-- work; `is_anonymous` is the explicit flag. Stories are public to all
-- authenticated users at the same school — that's the network mechanic.
CREATE TABLE IF NOT EXISTS stories (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  author_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  is_anonymous    BOOLEAN NOT NULL DEFAULT FALSE,
  school          TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  category        TEXT,                  -- e.g. 'success', 'warning', 'tip'
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  hidden          BOOLEAN NOT NULL DEFAULT FALSE   -- moderation flag
);
CREATE INDEX IF NOT EXISTS idx_stories_school_recent
  ON stories (school, created_at DESC) WHERE hidden = FALSE;

-- ── Best Roommate Award votes ───────────────────────────────────────────
-- One row per (voter, nominee) pair. The (voter_id, nominee_id) UNIQUE
-- prevents the same person voting twice for the same nominee.
CREATE TABLE IF NOT EXISTS best_roommate_votes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  voter_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nominee_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voter_school    TEXT NOT NULL,
  reason          TEXT,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT best_roommate_votes_unique UNIQUE (voter_id, nominee_id)
);
CREATE INDEX IF NOT EXISTS idx_best_roommate_votes_nominee
  ON best_roommate_votes (nominee_id);
CREATE INDEX IF NOT EXISTS idx_best_roommate_votes_school_recent
  ON best_roommate_votes (voter_school, created_at DESC);

-- ── Building Reviews (shared) ───────────────────────────────────────────
-- Cross-user-visible building reviews. Distinct from the local
-- `mySubmissions` list stored in localStorage by building-reviews.tsx;
-- this is the table other users read from.
CREATE TABLE IF NOT EXISTS building_reviews_shared (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reviewer_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  building_address  TEXT NOT NULL,
  move_in_date      TEXT,
  move_out_date     TEXT,
  rating_overall    INT NOT NULL CHECK (rating_overall BETWEEN 1 AND 5),
  rating_noise      INT CHECK (rating_noise BETWEEN 1 AND 5),
  rating_pest       INT CHECK (rating_pest BETWEEN 1 AND 5),
  rating_hvac       INT CHECK (rating_hvac BETWEEN 1 AND 5),
  rating_management INT CHECK (rating_management BETWEEN 1 AND 5),
  recommend         BOOLEAN,
  pros              TEXT,
  cons              TEXT,
  tips              TEXT,
  helpful_count     INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  hidden            BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_building_reviews_address
  ON building_reviews_shared (LOWER(building_address));

-- ── Landlord Reviews (shared) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS landlord_reviews_shared (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reviewer_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  landlord_name     TEXT NOT NULL,
  rating_overall    INT NOT NULL CHECK (rating_overall BETWEEN 1 AND 5),
  rating_response   INT CHECK (rating_response BETWEEN 1 AND 5),
  rating_maintenance INT CHECK (rating_maintenance BETWEEN 1 AND 5),
  rating_fairness   INT CHECK (rating_fairness BETWEEN 1 AND 5),
  review_text       TEXT NOT NULL,
  is_anonymous      BOOLEAN NOT NULL DEFAULT TRUE,
  helpful_count     INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  hidden            BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_landlord_reviews_name
  ON landlord_reviews_shared (LOWER(landlord_name));

-- ── match_pulses per-category columns ───────────────────────────────────
-- Adds the four roommate-health dimensions the Relationship Score screen
-- already shows. Existing pulses keep NULL for these (they were submitted
-- before per-category check-ins existed).
ALTER TABLE match_pulses
  ADD COLUMN IF NOT EXISTS communication_score INT CHECK (communication_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS chores_score        INT CHECK (chores_score        BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS noise_score         INT CHECK (noise_score         BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS respect_score       INT CHECK (respect_score       BETWEEN 0 AND 100);

COMMIT;
