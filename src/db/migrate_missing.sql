-- ═══════════════════════════════════════════════════════════════
--  HavenIQ — apply missing tables to Railway Postgres
--  All statements are idempotent; safe to run multiple times.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── Developer API keys (founder-managed; no consumer surface yet) ─────────────
-- Stores ONLY a sha256 hash of each secret — the plaintext is shown once at
-- creation and never persisted. `prefix` (first ~12 chars) is for identification
-- in the admin list. Nothing authenticates against these yet (stub); a future
-- developer-API middleware will hash the incoming key, find a non-revoked row,
-- constant-time compare, and bump last_used_at.
CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked      BOOLEAN NOT NULL DEFAULT FALSE
);
-- Supports the future verify path: lookup by hash among live keys.
CREATE INDEX IF NOT EXISTS idx_api_keys_live ON api_keys (key_hash) WHERE revoked = FALSE;

-- Premium (Stripe): the user's Stripe Customer id lives on the user row (per the
-- premium contract). Source of truth for customer lookup + the webhook matches
-- subscription.* events (which carry `customer` but no userId) back to a user via
-- this column. Subscription STATE (status/plan/period) lives in `subscriptions`.
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
-- Session revocation ("log out everywhere"). Tokens whose JWT `iat` predates this
-- instant are rejected by requireAuth. NULL = never revoked (so existing tokens
-- stay valid — no mass logout on deploy). Set to NOW() by POST /auth/logout-all,
-- which kills a stolen bearer token before its 7-day expiry.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_after TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ── Housing timing (LEGAL: public Zillow Research ZORI data, no scraping) ─────
-- Normalized monthly rent per metro from the public ZORI CSVs, plus a computed
-- per-metro "best time to lock in" seasonal summary. Populated by the weekly
-- ingest job / POST /bot-admin/ingest-housing. Empty until then — the endpoint
-- 404s and the app degrades to reasoned guidance.
CREATE TABLE IF NOT EXISTS housing_rent_index (
  region_key   TEXT NOT NULL,        -- normalized "city-st"
  region_name  TEXT NOT NULL,        -- "Riverside, CA"
  region_type  TEXT NOT NULL DEFAULT 'metro',
  state        TEXT,
  period       DATE NOT NULL,        -- month (first of month)
  rent         NUMERIC,              -- ZORI rent index
  source       TEXT DEFAULT 'Zillow Research (ZORI)',
  ingested_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (region_key, region_type, period)
);
CREATE TABLE IF NOT EXISTS housing_timing (
  region_key   TEXT PRIMARY KEY,      -- 'city:<key>' | '<metro-key>' | 'county:<FIPS>'
  region_name  TEXT NOT NULL,
  region_type  TEXT,                  -- 'city' | 'metro' | 'county'
  state        TEXT,
  timing       JSONB,                -- {bestMonthsToSearch,expectedSeasonalSwing?,leadTimeWeeks?,typicalRent?,hasSeasonal,asOf,source}
  computed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Crosswalk review queue: NEW / renamed / low-confidence-fuzzy school→metro
-- matches are HELD here for a human instead of auto-shipping a guess. High-
-- confidence exact matches go straight into the bundled crosswalk; these don't.
CREATE TABLE IF NOT EXISTS housing_crosswalk_review (
  id              BIGSERIAL PRIMARY KEY,
  school_name     TEXT,
  domain          TEXT,
  proposed_region TEXT,               -- the fuzzy candidate (NOT yet trusted)
  confidence      NUMERIC,            -- 0..1 token-Jaccard score
  reason          TEXT,               -- low_confidence | cross_state | distance | remap
  status          TEXT DEFAULT 'pending',   -- pending | approved | rejected
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS housing_review_status_idx ON housing_crosswalk_review (status);

-- Ensure newer columns on users exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS age              INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS neighborhoods    TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS roommate_status  TEXT;

-- Subscription data model: the populated GET /admin/users/:id/subscription shape
-- needs these two beyond the base table. Nullable/defaulted, so the endpoint
-- returns the {status:'none', …} default for everyone until Stripe is wired and
-- starts writing rows. (CREATE TABLE subscriptions lives in schema.sql.)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT FALSE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS price_label          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_email     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_notified  BOOLEAN DEFAULT FALSE;
-- v8 (1d): hard/soft match deal-breakers the app saves via PATCH /users/me.
-- { smokeFree, petsOk, quietHours, cleanlinessMin, maxBudget, leaseLength, moveInBy }
ALTER TABLE users ADD COLUMN IF NOT EXISTS match_dealbreakers JSONB DEFAULT '{}'::jsonb;
-- 2d: behavioral-truth. Latest synced validation_score [0,1] + its sample size;
-- fed into the scorer's step-4 multiplier. (validation_score may already exist
-- from the leaderboard — IF NOT EXISTS keeps this idempotent.)
ALTER TABLE users ADD COLUMN IF NOT EXISTS validation_score        NUMERIC;
ALTER TABLE users ADD COLUMN IF NOT EXISTS validation_sample_size  INTEGER;

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
-- Part 2: behavioral-validation layer exposed per row. pre_validation_pct = the
-- headline % BEFORE the multiplier; validation_multiplier defaults to a neutral
-- 1.0 (only ≠1 when BOTH users have a real validation_score — honesty gate).
ALTER TABLE compatibility_scores ADD COLUMN IF NOT EXISTS pre_validation_pct  INTEGER;
ALTER TABLE compatibility_scores ADD COLUMN IF NOT EXISTS validation_multiplier NUMERIC(4,3) DEFAULT 1.0;
-- Deep-matching #2: dimensions whose DIFFERENCE is why a pair fits (a certified
-- complementary shape + a genuinely far-apart pair). Structured so the app can
-- LEAD with "your <dim> styles balance each other" instead of relying on the
-- baked why_matched string. Empty/null until a shape is certified on outcomes.
ALTER TABLE compatibility_scores ADD COLUMN IF NOT EXISTS complementary_dims JSONB;
-- Deep-matching #6: dimensions where the pair's trajectories are materially
-- closing (projection/convergence earned). [{qid,label,note}]. Null/empty until
-- a shape + projection certify on outcomes. The app renders the note as a reason.
ALTER TABLE compatibility_scores ADD COLUMN IF NOT EXISTS converging_dims JSONB;

-- Confidence coefficient (<1 when either side's answers are thin/uniform — the
-- scorer already multiplies the score down by it). Stored so the feed can render
-- a low-confidence score as "still learning" instead of a hard, certain-looking
-- number. Default 1 = full confidence for pre-existing rows until they recompute.
ALTER TABLE compatibility_scores ADD COLUMN IF NOT EXISTS confidence NUMERIC(3,2) DEFAULT 1;

-- ── Part 3: the learning loop ─────────────────────────────────
-- Every connect / accept / decline, with the per-category compatibility
-- breakdown captured AT decision time. services/decisionLearning.js fits
-- per-user category weights from this and personalizes feed ORDER (never the
-- displayed score). Append-only; no fabricated rows — populated solely by real
-- user decisions.
CREATE TABLE IF NOT EXISTS match_decisions (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID REFERENCES users(id) ON DELETE CASCADE,
  target_user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  decision           TEXT NOT NULL CHECK (decision IN ('connect','accept','decline')),
  category_breakdown JSONB,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_match_decisions_user ON match_decisions(user_id, created_at DESC);

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

-- OTP purpose tag — distinguishes signup codes from logged-in .edu
-- re-verification codes ('email_verification') so the two streams share ONE
-- table/mailer/limiter without consuming each other's codes. Existing rows
-- backfill to 'signup' (the default), matching the live signup flow.
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'signup';
CREATE INDEX IF NOT EXISTS idx_otp_email_purpose ON otp_codes(email, purpose);

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

-- Lifecycle/marketing email opt-out (one-click unsubscribe, GET/POST /unsubscribe
-- via a signed token). Distinct from email_undeliverable (a bounce/spam signal):
-- this is a deliberate user choice. The lifecycle sender's eligibility query
-- excludes it; transactional email (login codes) never consults it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lifecycle_opted_out BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lifecycle_opted_out_at TIMESTAMPTZ;

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

-- ── Pairing outcomes (v8 scaffolding, 2026-06-24) ───────────────────────────
-- One row per canonical pair, recording the funnel from connect → message →
-- mutual match → met → moved-in, plus the failure signals (room change, block,
-- ghost). Captured best-effort via services/pairingOutcomes.js. PURPOSE: feed a
-- later per-school weight-learning step — back-solve which quiz dimensions
-- actually predict a successful cohabitation and retune QUESTION_POINTS from
-- real outcomes instead of priors. `school` + `score_at_match` are snapshotted
-- at connect time so learning can segment by campus and calibrate against the
-- score we showed. Additive + nullable; never blocks the user path.
CREATE TABLE IF NOT EXISTS pairing_outcomes (
  user_a           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school           TEXT,
  score_at_match   INTEGER,
  connected_at     TIMESTAMPTZ,
  first_message_at TIMESTAMPTZ,
  matched_at       TIMESTAMPTZ,
  met_at           TIMESTAMPTZ,
  moved_in_at      TIMESTAMPTZ,
  room_change_at   TIMESTAMPTZ,
  blocked_at       TIMESTAMPTZ,
  ghosted_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS idx_pairing_outcomes_school ON pairing_outcomes (school);
-- Impression logging (the FRONT of the funnel): a row is written/refreshed the
-- moment a pair is surfaced in a feed, snapshotting the model features + the
-- score we showed. The funnel timestamps above stamp the decision/outcome
-- events as they arrive. `features` is captured AT SERVE TIME (answers change;
-- the training set must reflect what was actually shown). This is pure logging —
-- it changes NO score. The interaction model trains off it later (λ=0 until it
-- beats the linear baseline on held-out data), so every served day is signal
-- banked now, not lost.
ALTER TABLE pairing_outcomes ADD COLUMN IF NOT EXISTS features         JSONB;
-- Formation-time freeze (services/formationCapture.js). Unlike `features` (the
-- mutable serve-time snapshot, refreshed on every impression), these are
-- WRITE-ONCE at match_lifecycle stage:'formed' — the launch-critical training
-- anchor. formed_at stamps when the pair actually matched; frozen_features holds
-- both users' full signal vectors (scored channels + zero-weight extras).
ALTER TABLE pairing_outcomes ADD COLUMN IF NOT EXISTS formed_at        TIMESTAMPTZ;
ALTER TABLE pairing_outcomes ADD COLUMN IF NOT EXISTS frozen_features  JSONB;
ALTER TABLE pairing_outcomes ADD COLUMN IF NOT EXISTS score_at_serve   INTEGER;
ALTER TABLE pairing_outcomes ADD COLUMN IF NOT EXISTS first_served_at  TIMESTAMPTZ;
ALTER TABLE pairing_outcomes ADD COLUMN IF NOT EXISTS last_served_at   TIMESTAMPTZ;
ALTER TABLE pairing_outcomes ADD COLUMN IF NOT EXISTS impression_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pairing_outcomes ADD COLUMN IF NOT EXISTS passed_at        TIMESTAMPTZ;
ALTER TABLE pairing_outcomes ADD COLUMN IF NOT EXISTS declined_at      TIMESTAMPTZ;

-- ── Deep-matching #2: learned per-dimension shapes ────────────────
-- One row per scored question. `certified=false` (the default, and the only
-- state until real outcomes accrue) means scoring.js keeps today's diffScore
-- curve for that dimension — bit-for-bit. A row goes `certified=true` ONLY when
-- the held-out gate (services/dimensionModel.js) proves a basis shape beats the
-- dist-only baseline on real "did it work?" outcomes. `shape` holds the baseline
-- + basis logistic coefficients the scorer applies. Empty table ⇒ today.
CREATE TABLE IF NOT EXISTS dimension_models (
  qid         INTEGER PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'similarity',  -- similarity | complementarity | directional
  certified   BOOLEAN NOT NULL DEFAULT FALSE,
  n           INTEGER,
  auc         NUMERIC,
  shape       JSONB,            -- { baseline:{intercept,coef}, basis:{intercept,coef} }
  reason      TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Deep-matching #6: per-dimension PROJECTION gate. When a dimension's certified
-- shape also earns trajectory projection on held-out outcomes, project = TRUE
-- and the scorer scores that dimension on the velocity-projected value instead
-- of the stale snapshot. FALSE (default) ⇒ snapshot-only, bit-for-bit today.
ALTER TABLE dimension_models ADD COLUMN IF NOT EXISTS project BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Deep-matching #6: trajectory / velocity ───────────────────
-- The app posts pulse_drift telemetry (per-question least-squares velocity in
-- answer-units / 30 days, with baseline/current/trend/sampleSize). We persist
-- the LATEST per (user, question) for scoring, and keep full history so the
-- trainer can reconstruct velocity at a pairing's serve time. We DO NOT recompute
-- velocity — the app owns the baseline anchor + answer→value normalization.
CREATE TABLE IF NOT EXISTS pulse_drift (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL,
  velocity     NUMERIC,          -- slope in answer-units per 30 days
  baseline     NUMERIC,
  current      NUMERIC,
  delta        NUMERIC,
  trend        TEXT,             -- 'stable' | 'shifting' | 'changed'
  sample_size  INTEGER,
  snapshot_id  TEXT,
  computed_at  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, question_id)
);
CREATE TABLE IF NOT EXISTS pulse_drift_history (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL,
  velocity     NUMERIC,
  current      NUMERIC,
  trend        TEXT,
  sample_size  INTEGER,
  snapshot_id  TEXT,
  computed_at  TIMESTAMPTZ,
  recorded_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pulse_drift_hist_user ON pulse_drift_history (user_id, question_id, computed_at DESC);

-- ── Deep-matching #5: LLM grounded text-insight features ──────
-- DERIVED-ONLY: the numeric living-habits construct vector + one-line rationales
-- an LLM read from a CONSENTING student's own free text. The raw text is NEVER
-- stored (source_hash detects changes to trigger re-extraction). Extracted only
-- for users whose latest `textInsight` consent is true; purged on withdrawal.
CREATE TABLE IF NOT EXISTS text_insight_features (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vector        JSONB,            -- { "<construct>": 0..1, ... }
  rationales    JSONB,            -- { "<construct>": "one-line reason", ... }
  model_version TEXT,
  source_hash   TEXT,             -- hash of the input text (NOT the text itself)
  computed_at   TIMESTAMPTZ DEFAULT NOW()
);
-- Per-construct learned shapes (gated like #2). certified=false (default, and the
-- only state until outcomes accrue) ⇒ the construct's weight is 0 ⇒ today.
CREATE TABLE IF NOT EXISTS text_insight_models (
  construct   TEXT PRIMARY KEY,
  certified   BOOLEAN NOT NULL DEFAULT FALSE,
  type        TEXT,
  n           INTEGER,
  auc         NUMERIC,
  shape       JSONB,              -- { baseline:{intercept,coef}, basis:{intercept,coef} }
  reason      TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Launch-capacity indexes (2026-07 University of Ohio load-test) ───────────
-- Serve GET /matches/feed — the heaviest endpoint — without a sequential scan
-- degrading first under load. The feed's driving query is:
--     FROM compatibility_scores cs
--     JOIN users u ON (CASE WHEN cs.user_a=$1 THEN cs.user_b ELSE cs.user_a END)
--     LEFT JOIN connect_requests cr ON (from=$1 AND to=u.id) OR (to=$1 AND from=u.id)
--     WHERE (cs.user_a=$1 OR cs.user_b=$1) AND ... ORDER BY cs.score DESC LIMIT 50
--
-- (1) connect_requests.from_user had NO index (only to_user did), so the feed's
--     LEFT JOIN and the /connect + match-detail lookups seq-scanned it. Add it.
CREATE INDEX IF NOT EXISTS idx_requests_from ON connect_requests(from_user);
--
-- (2) Composite (user, score DESC) covers the WHERE (user_a=$1 / user_b=$1) plus
--     the ORDER BY cs.score DESC in one index scan — no post-filter sort. The OR
--     is planned as a BitmapOr of the two. These SUPERSEDE the single-column
--     idx_scores_user_a / idx_scores_user_b (kept for now; drop once EXPLAIN
--     ANALYZE on staging confirms the composites are the chosen plan).
CREATE INDEX IF NOT EXISTS idx_scores_user_a_score ON compatibility_scores(user_a, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_user_b_score ON compatibility_scores(user_b, score DESC);

-- ── Multi-photo profiles (user_photos) — 2026-07-13 ─────────────────────────
-- Per-user photo gallery (cap of 6 enforced in the route). position 0 = primary;
-- the routes keep users.photo_url synced to the position-0 photo so legacy
-- consumers are unchanged. gen_random_uuid() needs pgcrypto.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS user_photos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  public_id  TEXT,
  position   SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_photos_user_pos ON user_photos (user_id, position);

-- ── Stress dimension (docs/specs/stress-response-dimension.md §4) ────────────
-- Per-pair "under pressure" read: { score, pattern, headline, pactSuggestion }.
-- Written by the scorer (services/scoring.js scoreStress + stressInsight), served
-- on the match payload. NULL for every pair until the app flips STRESS_IDS into
-- SCORED_IDS, so the frontend's presence-gate keeps the row unrendered until then.
ALTER TABLE compatibility_scores ADD COLUMN IF NOT EXISTS under_pressure JSONB;

-- ── Longitudinal pair telemetry (pair_events) — 2026-07-21 ──────────────────
-- The ground-truth roommate dataset: signal → intervention → outcome, per pair.
-- Written from the /telemetry/batch side-channel; read only by /research/*.
--
-- ids are TEXT, not UUID with an FK to users, on purpose: pair_id may be an
-- unlinked roommate who has no account, so a foreign key would reject exactly
-- the one-sided pairings the brief says to keep.
--
-- pair_key is the UNORDERED pair — sorted([user_id, pair_id]) joined by ':' —
-- derived server-side on insert. Each side emits keyed on the OTHER person
-- (A sends pairId=B, B sends pairId=A), so without this the two halves of the
-- same roommate relationship would never group together.
CREATE TABLE IF NOT EXISTS pair_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  pair_id    TEXT NOT NULL,
  pair_key   TEXT NOT NULL,
  t          BIGINT NOT NULL,
  kind       TEXT NOT NULL,
  subtype    TEXT NOT NULL,
  topic      TEXT,
  value      DOUBLE PRECISION,
  meta       JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pair_events_pair_t ON pair_events (pair_key, t);
-- Bulk cohort export (?since=) and the GDPR per-user export/erasure paths.
CREATE INDEX IF NOT EXISTS idx_pair_events_t       ON pair_events (t);
CREATE INDEX IF NOT EXISTS idx_pair_events_user    ON pair_events (user_id);

-- ── Close the Loop: counterfactual columns + consent (2026-07-23) ────────────
-- pair_events already exists (the longitudinal ledger). These two columns are
-- what turn it from "this pair improved" into a comparable claim: every event in
-- a conflict episode carries the episode it belongs to and the arm that episode
-- was assigned, so intervened pairs can be diffed against held-back controls.
--
-- arm is stamped SERVER-SIDE at conflict_flagged and copied onto every later
-- event in the episode. NULL for non-episode events (ordinary pulses etc.).
ALTER TABLE pair_events ADD COLUMN IF NOT EXISTS arm        TEXT;
ALTER TABLE pair_events ADD COLUMN IF NOT EXISTS episode_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pair_events_episode ON pair_events (episode_id)
  WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pair_events_arm     ON pair_events (arm, pair_key)
  WHERE arm IS NOT NULL;

-- Explicit per-pair consent. No pair is tracked without a row here — the ledger
-- is a record of two real people's conflict, so v1 is a small consented cohort.
CREATE TABLE IF NOT EXISTS pair_consent (
  pair_id      TEXT PRIMARY KEY,          -- the sorted unordered pair (= pair_events.pair_key)
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scope        TEXT,                      -- what they agreed to, in words
  revoked_at   TIMESTAMPTZ,               -- consent is withdrawable; NULL = active
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Roommate safety reports (cross-referenceable safety record) — 2026-07-30 ──
-- A dedicated, queryable table so the same person reported by DIFFERENT students
-- surfaces as a PATTERN to the safety team. gen_random_uuid needs pgcrypto,
-- ensured earlier in this file. Route: src/routes/roommateSafety.js.
CREATE TABLE IF NOT EXISTS roommate_safety_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_safety_reports_reported ON roommate_safety_reports(reported_id);
CREATE INDEX IF NOT EXISTS idx_safety_reports_reporter ON roommate_safety_reports(reporter_id);
