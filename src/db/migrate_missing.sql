-- ═══════════════════════════════════════════════════════════════
--  HavenIQ — apply missing tables to Railway Postgres
--  All statements are idempotent; safe to run multiple times.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Ensure newer columns on users exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS age             INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS neighborhoods   TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS roommate_status TEXT;

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

-- ── Trigger function + connect_requests trigger ───────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER requests_updated_at
  BEFORE UPDATE ON connect_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();
