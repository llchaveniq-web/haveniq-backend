-- ═══════════════════════════════════════════════════════════════
--  Migration: 2026-05-23 identity_verifications
--
--  Tracks Stripe Identity verification sessions per user. We don't
--  store any of the actual ID data — Stripe holds that. We just keep
--  the session id and the latest status so the UI can show a
--  "Verified" badge without re-querying Stripe on every render.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS identity_verifications (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Stripe's VerificationSession id (vs_xxx).
  stripe_session_id TEXT NOT NULL UNIQUE,
  -- Latest status from Stripe: requires_input | processing | verified |
  -- canceled | requires_action. We only mark a user "verified" when this
  -- becomes 'verified'.
  status            TEXT NOT NULL DEFAULT 'requires_input',
  -- Stripe's last_error code if the verification failed. Useful for
  -- showing a meaningful retry message.
  last_error_code   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identity_user
  ON identity_verifications (user_id, created_at DESC);

COMMIT;
