-- ═══════════════════════════════════════════════════════════════
--  Migration: 2026-05-24 user_bans — hard-ban columns on users
--
--  Adds three columns to the users table so the founder can ban a user
--  without deleting their account. Distinct from is_paused (user-initiated
--  break from the platform) — is_banned is platform-initiated and the
--  user cannot self-unban from settings.
--
--  is_banned         — TRUE means the user is locked out + invisible
--  banned_at         — when the ban was applied (audit trail)
--  ban_reason        — short note for triage history (founder-only,
--                      never shown to the banned user)
--
--  Filtering against is_banned happens in feed queries, message
--  conversations, and connect-request guards — same shape as the
--  is_paused checks already in place.
--
--  Apply via Railway → Postgres → Data tab. ADD COLUMN IF NOT EXISTS
--  makes this safe to re-run.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_banned   BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS banned_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ban_reason  TEXT;

-- Partial index — feed queries filter "AND is_banned = FALSE" most often,
-- so the index covers the common case. A partial index keeps it tiny
-- since 99.9%+ of users will never be banned.
CREATE INDEX IF NOT EXISTS idx_users_banned
  ON users (banned_at DESC) WHERE is_banned = TRUE;

COMMIT;
