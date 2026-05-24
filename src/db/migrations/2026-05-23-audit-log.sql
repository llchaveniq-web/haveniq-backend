-- ═══════════════════════════════════════════════════════════════
--  Migration: 2026-05-23 audit_log
--
--  Append-only record of sensitive operations a user performs on their
--  own account. Used for:
--    • GDPR Article 15 access requests ("show me everything you did with
--      my data") — far more honest than reconstructing from the DB at
--      query time.
--    • Forensics when something goes wrong ("when exactly did this user
--      delete their account?").
--    • Detecting abuse patterns ("100 photo uploads in 5 min from one
--      account" suggests a bot).
--
--  Schema is deliberately minimal — no PII duplication. The `details`
--  JSONB column holds action-specific context but we keep it small.
--  Rows are NEVER updated or deleted, even on account-delete cascade —
--  we set user_id to NULL instead so the legal record survives.
--
--  Apply via Railway → Postgres → Data tab. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- user_id is NULLABLE: when the user deletes their account, we null
  -- this out (via the FK ON DELETE SET NULL) so the audit row survives
  -- account deletion. The action+timestamp+ip stay as forensic evidence
  -- even after the user is gone.
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Action verb. Conventions: "snake.dot" e.g. "account.delete",
  -- "profile.patch", "photo.upload", "plaid.connect", "plaid.disconnect",
  -- "identity.start", "identity.verified".
  action        TEXT NOT NULL,
  -- Free-form action context. Keep small. Examples:
  --   { "fields": ["bio", "age"] }   -- what changed on profile.patch
  --   { "institution": "BofA" }      -- which bank on plaid.connect
  --   { "reason": "explicit" }       -- why on photo.upload.rejected
  details       JSONB,
  -- Caller IP (collapsed by /64 for IPv6 to avoid PII over-collection).
  ip            INET,
  -- Truncated User-Agent for spotting bot patterns. Don't log full UA.
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_recent
  ON audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action_recent
  ON audit_log (action, created_at DESC);

COMMIT;
