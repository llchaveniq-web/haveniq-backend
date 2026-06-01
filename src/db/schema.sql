-- ═══════════════════════════════════════════════════════════════
--  HavenIQ Database Schema
--  Run once on a fresh PostgreSQL database.
--  Railway: paste into the query runner in your Railway dashboard.
-- ═══════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- for name search

-- ── Users ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email             TEXT UNIQUE NOT NULL,
  school            TEXT NOT NULL,
  school_domain     TEXT NOT NULL,

  -- Profile
  first_name        TEXT,
  last_name         TEXT,
  bio               TEXT,
  major             TEXT,
  school_year       TEXT,   -- Freshman / Sophomore / Junior / Senior / Graduate
  age               INTEGER,
  gender            TEXT,
  looking_for       TEXT[], -- ['Man','Woman','Non-binary']
  photo_url         TEXT,

  -- Preferences
  budget_min        INTEGER DEFAULT 500,
  budget_max        INTEGER DEFAULT 2000,
  move_in_timeline  TEXT,   -- '1 month' / '2 months' / etc.
  neighborhoods     TEXT[], -- ['Westwood','North Berkeley',...]
  roommate_status   TEXT,   -- 'actively_looking' | 'open_to_offers' | 'found_roommate'
  dealbreakers      TEXT[] DEFAULT '{}', -- up to 3 "what matters most" tags;
                                         -- vocab: sleep, cleanliness, noise,
                                         -- guests, substances, alcohol, money,
                                         -- communication, space (mirror of
                                         -- scoring.js DEALBREAKER_QUESTIONS keys)

  -- Status flags
  is_verified       BOOLEAN DEFAULT FALSE,   -- selfie + enrollment verified
  is_paused         BOOLEAN DEFAULT FALSE,   -- paused from match feed
  quiz_completed    BOOLEAN DEFAULT FALSE,
  is_premium        BOOLEAN DEFAULT FALSE,
  trust_score       INTEGER DEFAULT 20,      -- 0–100

  -- Timestamps
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent migration for existing databases — new installs get the columns
-- via CREATE TABLE above, existing prod databases need these ALTERs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS age              INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS neighborhoods    TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS roommate_status  TEXT;
-- Parents-as-positive-signal play. Optional parent email collected during
-- onboarding (or via Settings). On a student's FIRST accepted match we
-- send the parent a one-time "your student just matched with X, .edu
-- verified" email — converts the parent from a veto-risk into a buy-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_email     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_notified  BOOLEAN DEFAULT FALSE;
-- Per-user dealbreaker tags — up to 3 "what matters most" picks chosen
-- in profile setup. Backend scoring.js unions both users' tags and
-- amplifies the relevant question weights, so each student gets matches
-- tuned to their personal priorities. Empty array = "no priorities set,
-- score me with the default weights."
ALTER TABLE users ADD COLUMN IF NOT EXISTS dealbreakers     TEXT[] DEFAULT '{}';
-- Stripe Identity verification — denormalized timestamp on users (vs.
-- joining against identity_verifications every read). Set by the Stripe
-- webhook + /identity/refresh when status flips to 'verified'. NULL when
-- the user hasn't completed Stripe's selfie+ID flow. Surfaces on match
-- cards as the "ID ✓" trust badge — meaningful escalation above the
-- baseline ".edu verified" because it confirms a real human matches the
-- ID photo (not just that they own a school email).
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_verified_at TIMESTAMPTZ;
-- 2FA (TOTP). Three columns. totp_secret stays NULL until setup; it's
-- written by /auth/2fa/setup. totp_enabled stays FALSE until the user
-- proves they can read codes off their authenticator (verify-setup).
-- totp_recovery_codes are bcrypt hashes of 10 one-time-use codes;
-- each successful use removes the matching hash from the array.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled         BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_codes  TEXT[]  DEFAULT '{}';

-- ── OTP codes ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,
  attempts    INTEGER DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);

-- ── Quiz answers ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_answers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  answers       JSONB NOT NULL,   -- { "1": 2, "2": 0, ... } question_id -> option_index
  completed     BOOLEAN DEFAULT FALSE,
  -- Optional voice-interview transcripts: [{ question, transcript }, ...].
  -- Populated by /quiz/voice/submit when a student records the spoken
  -- interview; folded into the AI personality profile as richer signal.
  voice_answers JSONB,
  -- Optional free-text writing sample (essay / paper / personal statement)
  -- the student volunteered; folded into the AI personality profile too.
  writing_sample TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);
-- Idempotent column adds for databases created before these existed.
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS voice_answers  JSONB;
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS writing_sample TEXT;

-- ── Compatibility scores ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compatibility_scores (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a            UUID REFERENCES users(id) ON DELETE CASCADE,
  user_b            UUID REFERENCES users(id) ON DELETE CASCADE,
  score             NUMERIC(5,2) NOT NULL,    -- 0.00–100.00
  is_hard_blocked   BOOLEAN DEFAULT FALSE,
  is_soft_blocked   BOOLEAN DEFAULT FALSE,
  shadow_penalty    NUMERIC(4,2) DEFAULT 0,
  breakdown         JSONB,                    -- { "attachment": 88, "emotional": 91, ... }
  why_matched       TEXT,
  calculated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_a, user_b),
  CHECK (user_a < user_b)  -- canonical ordering prevents duplicate pairs
);
CREATE INDEX IF NOT EXISTS idx_scores_user_a ON compatibility_scores(user_a);
CREATE INDEX IF NOT EXISTS idx_scores_user_b ON compatibility_scores(user_b);

-- ── Connect requests ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connect_requests (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_user   UUID REFERENCES users(id) ON DELETE CASCADE,
  to_user     UUID REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'pending',  -- pending / accepted / declined
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_user, to_user)
);
CREATE INDEX IF NOT EXISTS idx_requests_to ON connect_requests(to_user);

-- ── Conversations ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a       UUID REFERENCES users(id) ON DELETE CASCADE,
  user_b       UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_a, user_b),
  CHECK (user_a < user_b)
);

-- ── Messages ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  read            BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC);

-- ── Roommate reviews ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roommate_reviews (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reviewer_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  reviewee_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  overall_rating  INTEGER CHECK (overall_rating BETWEEN 1 AND 5),
  cleanliness     INTEGER CHECK (cleanliness BETWEEN 1 AND 5),
  communication   INTEGER CHECK (communication BETWEEN 1 AND 5),
  respect         INTEGER CHECK (respect BETWEEN 1 AND 5),
  noise_level     INTEGER CHECK (noise_level BETWEEN 1 AND 5),
  body            TEXT,
  helpful_count   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(reviewer_id, reviewee_id)
);

-- ── Profile views ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profile_views (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  viewer_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  viewed_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  viewed_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_views_viewed ON profile_views(viewed_id, viewed_at DESC);

-- ── User profile snapshots ───────────────────────────────────────────────
-- Frozen point-in-time captures of a user's profile + quiz state. Powers
-- longitudinal drift analysis ("how has this person changed since freshman
-- year?") and gives compatibility scoring something to compare against
-- when re-quiz answers shift over time. Writers: quiz completion (every
-- submit creates one row). Future: weekly cron for active users.
CREATE TABLE IF NOT EXISTS user_profile_snapshot (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  trigger     TEXT NOT NULL,
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON user_profile_snapshot(user_id, created_at DESC);

-- ── Shared move-in checklists ────────────────────────────────────────────
-- One row per accepted match. Both roommates read & write the same JSONB
-- so when one ticks "Get keys" the other sees it next time they pull to
-- refresh. Not real-time (no websocket sync yet) but eventually consistent.
CREATE TABLE IF NOT EXISTS match_checklists (
  request_id    UUID PRIMARY KEY REFERENCES connect_requests(id) ON DELETE CASCADE,
  items         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL
);

-- ── Squad / group matching ───────────────────────────────────────────────
-- Students forming a group of 2-5 to look for housing together.
-- A group has one creator + N members; the creator is also a member.
-- Group-to-apartment + group-to-group matching is future work; for now
-- this is just persistence of the group itself.
CREATE TABLE IF NOT EXISTS match_groups (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  creator_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  size_target   INTEGER NOT NULL CHECK (size_target BETWEEN 2 AND 5),
  budget_per_person_min INTEGER,
  budget_per_person_max INTEGER,
  move_in_window TEXT,        -- 'ASAP' | 'Next month' | 'This semester' | 'Next semester'
  status        TEXT NOT NULL DEFAULT 'forming' CHECK (status IN ('forming', 'complete', 'archived')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_groups_creator ON match_groups(creator_id);

CREATE TABLE IF NOT EXISTS match_group_members (
  group_id      UUID NOT NULL REFERENCES match_groups(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('creator', 'member')),
  joined_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON match_group_members(user_id);

-- ── Premium subscriptions (Stripe-backed) ────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL,
  plan                   TEXT,
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(stripe_customer_id);

-- ── Apartment listings ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  address               TEXT NOT NULL,
  city                  TEXT,
  school_near           TEXT NOT NULL,
  beds                  INTEGER NOT NULL CHECK (beds BETWEEN 1 AND 10),
  baths                 NUMERIC(3,1) NOT NULL CHECK (baths > 0),
  total_rent_cents      INTEGER NOT NULL CHECK (total_rent_cents > 0),
  per_person_rent_cents INTEGER NOT NULL CHECK (per_person_rent_cents > 0),
  photo_url             TEXT,
  contact_name          TEXT,
  contact_email         TEXT,
  available_from        DATE,
  notes                 TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_listings_school ON listings(school_near) WHERE is_active = TRUE;

-- ── Group-to-group interest signals ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_interests (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_group  UUID NOT NULL REFERENCES match_groups(id) ON DELETE CASCADE,
  to_group    UUID NOT NULL REFERENCES match_groups(id) ON DELETE CASCADE,
  initiator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  CHECK (from_group != to_group),
  UNIQUE (from_group, to_group)
);
CREATE INDEX IF NOT EXISTS idx_group_interests_to ON group_interests(to_group);

-- ── Match outcome pulses ─────────────────────────────────────────────────
-- The "did this match actually work?" feedback loop. Every accepted
-- connect_request is eligible for a pulse at 30 / 60 / 90 days after the
-- acceptance. This is THE dataset that proves (or disproves) that the
-- compatibility algorithm produces lasting roommate relationships — every
-- fundraising deck rests on the answers in this table.
CREATE TABLE IF NOT EXISTS match_pulses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id    UUID REFERENCES connect_requests(id) ON DELETE CASCADE,
  responder_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  day_marker    INTEGER NOT NULL CHECK (day_marker IN (30, 60, 90)),
  status        TEXT    NOT NULL CHECK (status IN ('going_well', 'having_issues', 'not_connected', 'moved_out')),
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(request_id, responder_id, day_marker)
);
CREATE INDEX IF NOT EXISTS idx_pulses_responder ON match_pulses(responder_id, created_at DESC);

-- ── Push tokens ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    TEXT,   -- 'ios' | 'android'
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(token)
);

-- ── Updated_at trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER quiz_updated_at
  BEFORE UPDATE ON quiz_answers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER requests_updated_at
  BEFORE UPDATE ON connect_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Personality profiles (AI-derived) ────────────────────────────────────
-- One row per user. Produced once at quiz submission by
-- services/personality.js — a single Anthropic call turns the 22 quiz
-- answers into a Big Five (OCEAN) profile + archetype + narrative.
--   ocean  : { openness, conscientiousness, extraversion, agreeableness,
--             neuroticism }, each 0-100
--   source : 'anthropic' normally, or 'fallback' when the API key is missing
--            / the call failed (deterministic estimate — never blank)
CREATE TABLE IF NOT EXISTS personality_profiles (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  archetype    TEXT,
  mbti         TEXT,   -- secondary display label (Myers-Briggs 4-letter)
  disc         TEXT,   -- secondary display label (DISC style)
  ocean        JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary      TEXT,
  strengths    JSONB DEFAULT '[]'::jsonb,
  growth_areas JSONB DEFAULT '[]'::jsonb,
  roommate_fit TEXT,
  model        TEXT,
  source       TEXT DEFAULT 'anthropic',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
-- Idempotent column adds for databases created before mbti/disc existed.
ALTER TABLE personality_profiles ADD COLUMN IF NOT EXISTS mbti TEXT;
ALTER TABLE personality_profiles ADD COLUMN IF NOT EXISTS disc TEXT;
CREATE OR REPLACE TRIGGER personality_updated_at
  BEFORE UPDATE ON personality_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Partner offers (resource lead-gen) ───────────────────────────────────
-- Sponsored perks shown to students — furniture, insurance, moving help,
-- etc. click_count is the billable pay-per-lead metric.
CREATE TABLE IF NOT EXISTS partner_offers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         TEXT NOT NULL,
  blurb         TEXT,
  category      TEXT,
  sponsor_name  TEXT,
  cta_label     TEXT DEFAULT 'Learn more',
  cta_url       TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  click_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_partner_offers_active ON partner_offers(is_active);
