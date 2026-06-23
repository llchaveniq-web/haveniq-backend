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
-- Optional voice-interview transcripts: [{ question, transcript }, ...].
-- Populated by /quiz/voice/submit; folded into the AI personality profile.
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS voice_answers JSONB;
-- Optional free-text writing sample (essay / paper / personal statement).
-- Populated by /quiz/writing; folded into the AI personality profile.
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS writing_sample TEXT;

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
-- Optional free-text reason captured when a request is DECLINED. Low-friction
-- metadata for matching-algorithm tuning ("why didn't it work?") — only ever
-- prompted at the decline decision point, never on the high-frequency swipe.
ALTER TABLE connect_requests ADD COLUMN IF NOT EXISTS decline_reason TEXT;

-- ── Conversations ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a       UUID REFERENCES users(id) ON DELETE CASCADE,
  user_b       UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_a, user_b),
  CHECK (user_a < user_b)
);
-- Soft-disconnect ("unmatch") — a graceful end to a connection, distinct from
-- a block. We keep the row (safety/audit, e.g. harassment AFTER an unmatch)
-- and just mark it ended: messaging stops and the thread drops off both lists.
-- Reversible by design; not hostile like a block.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ended_by UUID;

-- ── Messages ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  read            BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- Backfill columns onto stale prod tables. CREATE TABLE IF NOT EXISTS is
-- a no-op when the table exists, so any column added to the definition
-- above after the table first shipped never reaches an old prod row.
-- The CREATE INDEX below references created_at, so without this ALTER
-- the bootstrap throws "column created_at does not exist" on the index
-- step. Idempotent ADD COLUMN IF NOT EXISTS makes this safe on every
-- shape of database.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
-- read_at: when a message was read, for live read-receipts (socket
-- 'mark_read' → 'messages_read'). Nullable; set only when the recipient reads.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
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
ALTER TABLE profile_views ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_views_viewed ON profile_views(viewed_id, viewed_at DESC);

-- ── User profile snapshots ────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_profile_snapshot (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  trigger     TEXT NOT NULL,
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_profile_snapshot ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
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
ALTER TABLE match_pulses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
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

-- ── Partner offers (resource lead-gen) ────────────────────────
-- Sponsored perks shown to students — furniture, insurance, moving help,
-- etc. click_count is the billable pay-per-lead metric (the Angie's-list
-- model: a partner is charged per qualified click/lead delivered).
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

-- ── 2FA (TOTP) — see migrations/2026-06-01-2fa-totp.sql for the full
--    rationale on each column. Mirrored here so the prod-deploy
--    `psql -f migrate_missing.sql` bundle picks them up.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled         BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_codes  TEXT[]  DEFAULT '{}';

-- ── user_blocks + user_reports
--    Originally lived only in migrations/2026-05-24-blocks-and-reports.sql,
--    which is applied by hand. Folded in here because the message-report
--    ALTER below (and the GET-thread block-check filter on backend) both
--    depend on these tables existing, and several follow-on routes (bot
--    moderation, admin safety queue) silently fail when they don't.
CREATE TABLE IF NOT EXISTS user_blocks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_blocks_unique   UNIQUE (blocker_id, blocked_id),
  CONSTRAINT user_blocks_not_self CHECK  (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks (blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks (blocked_id);

CREATE TABLE IF NOT EXISTS user_reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  reported_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'medium',
  reason        TEXT,
  details       TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_reports_open
  ON user_reports (status, created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_user_reports_reported
  ON user_reports (reported_id, created_at DESC) WHERE reported_id IS NOT NULL;

-- ── Sign-in audit log — one row per successful sign-in event so the
--    user can review their own "Recent activity" on Profile. Method
--    distinguishes email-only OTP from 2FA-verified sessions. IP is
--    stored as a /24 prefix (or /48 for v6) for coarse geographic
--    hinting without precise tracking. user_agent is truncated to
--    256 chars to stay light.
CREATE TABLE IF NOT EXISTS sign_in_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method       TEXT NOT NULL,      -- 'otp' | '2fa' | 'recovery_code' | 'refresh'
  ip_prefix    TEXT,
  user_agent   TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sign_in_events_user
  ON sign_in_events (user_id, occurred_at DESC);

-- ── Resend bounce flag — set TRUE by the /webhooks/resend handler
--    whenever a hard-bounce or complaint webhook fires for the user's
--    address. /auth/send-code refuses to send new OTPs to a flagged
--    address (and surfaces a "this email seems undeliverable" hint
--    to the founder during recruitment debugging).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_undeliverable BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_undeliverable_reason TEXT;

-- ── Message-specific reports — long-press on a Journal message →
--    "Report message" should record which specific message tripped the
--    report (not just which user). Lets the moderator open the report
--    and see the exact body that was flagged instead of scrolling the
--    whole thread looking for the offending line.
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_user_reports_message ON user_reports (message_id) WHERE message_id IS NOT NULL;

-- ── Presence: last time a user was active in the app. Updated (throttled to
--    once / 5 min) by requireAuth on every authenticated request; returned in
--    the match feed and shown on match cards as "Active today / Active Nd ago".
--    Additive + nullable = safe; real users get a real value on first request.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- Seed the demo pool with a realistic recent spread so the founder can SEE the
-- presence label while testing (demo accounts never make real requests).
-- Guarded on IS NULL: seeds once, never overwrites a real user's activity.
UPDATE users
   SET last_active_at = NOW() - (random() * INTERVAL '6 days')
 WHERE email LIKE '%@haveniq-demo.edu' AND last_active_at IS NULL;
