-- ═══════════════════════════════════════════════════════════════
--  HavenIQ — apply missing tables to Railway Postgres
--  All statements are idempotent; safe to run multiple times.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Ensure newer columns on users exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS age              INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS neighborhoods    TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS roommate_status  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_email     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_notified  BOOLEAN DEFAULT FALSE;

-- The original quiz_answers table on Railway lacked the `completed` column
-- that /quiz/submit relies on. Caused every real student's submit to 500
-- with "column does not exist". Idempotent fix.
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT FALSE;
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ── Compatibility scores ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS compatibility_scores (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a            UUID REFERENCES users(id) ON DELETE CASCADE,
  user_b            UUID REFERENCES users(id) ON DELETE CASCADE,
  score             NUMERIC(5,2) NOT NULL,
  is_hard_blocked   BOOLEAN DEFAULT FALSE,
  is_soft_blocked   BOOLEAN DEFAULT FALSE,
  shadow_penalty    NUMERIC(4,2) DEFAULT 0,
  breakdown         JSONB,
  why_matched       TEXT,
  calculated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS idx_scores_user_a ON compatibility_scores(user_a);
CREATE INDEX IF NOT EXISTS idx_scores_user_b ON compatibility_scores(user_b);

-- ── Connect requests (unblocks /users/me) ─────────────────────
CREATE TABLE IF NOT EXISTS connect_requests (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_user   UUID REFERENCES users(id) ON DELETE CASCADE,
  to_user     UUID REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_user, to_user)
);
CREATE INDEX IF NOT EXISTS idx_requests_to ON connect_requests(to_user);

-- ── Conversations ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a       UUID REFERENCES users(id) ON DELETE CASCADE,
  user_b       UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_a, user_b),
  CHECK (user_a < user_b)
);

-- ── Messages ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  read            BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC);

-- ── Roommate reviews ──────────────────────────────────────────
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

-- ── Profile views ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profile_views (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  viewer_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  viewed_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  viewed_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_views_viewed ON profile_views(viewed_id, viewed_at DESC);

-- ── User profile snapshots ────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_profile_snapshot (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  trigger     TEXT NOT NULL,
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON user_profile_snapshot(user_id, created_at DESC);

-- ── Shared move-in checklists ─────────────────────────────────
CREATE TABLE IF NOT EXISTS match_checklists (
  request_id    UUID PRIMARY KEY REFERENCES connect_requests(id) ON DELETE CASCADE,
  items         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL
);

-- ── Squad / group matching ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS match_groups (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  creator_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  size_target   INTEGER NOT NULL CHECK (size_target BETWEEN 2 AND 5),
  budget_per_person_min INTEGER,
  budget_per_person_max INTEGER,
  move_in_window TEXT,
  status        TEXT NOT NULL DEFAULT 'forming' CHECK (status IN ('forming', 'complete', 'archived')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_groups_creator ON match_groups(creator_id);

CREATE TABLE IF NOT EXISTS match_group_members (
  group_id  UUID NOT NULL REFERENCES match_groups(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('creator', 'member')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON match_group_members(user_id);

-- ── Premium subscriptions (Stripe-backed, opt-in until activated) ──
-- One row per user, kept in sync with Stripe via webhook. status mirrors
-- the Stripe subscription.status verbatim so we don't drift over time.
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

-- ── Apartment listings (founder-curated until partnerships land) ─
-- school_near is a free-form string (e.g. "Orange Coast College") used
-- for same-school filtering — matches the convention in users.school.
-- per_person_rent is stored explicitly because total / beds can be off
-- (some leases have shared masters, dens, etc.).
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

-- ── Group-to-group interest signals ───────────────────────────────
-- When squad A "expresses interest" in squad B, we record a row here.
-- Mutual interest (B → A also exists) becomes the basis for opening a
-- multi-party conversation or a combined housing search. Status field
-- supports future moderation (block / dismiss).
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

-- ── Match outcome pulses (30/60/90-day feedback) ──────────────
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

-- ── Trigger function + connect_requests trigger ───────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER requests_updated_at
  BEFORE UPDATE ON connect_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Personality profiles (AI-derived) ─────────────────────────
-- One row per user. Written once at quiz submission by
-- services/personality.js (a single Anthropic call → OCEAN + archetype).
CREATE TABLE IF NOT EXISTS personality_profiles (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  archetype    TEXT,
  mbti         TEXT,
  disc         TEXT,
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
ALTER TABLE personality_profiles ADD COLUMN IF NOT EXISTS mbti TEXT;
ALTER TABLE personality_profiles ADD COLUMN IF NOT EXISTS disc TEXT;
CREATE OR REPLACE TRIGGER personality_updated_at
  BEFORE UPDATE ON personality_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
