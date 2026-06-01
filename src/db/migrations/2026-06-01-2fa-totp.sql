-- ── 2FA (TOTP) — wire the Profile screen's Two-Factor Auth row
--   to real account security instead of a mockup.
--
-- Three columns on users:
--
--   totp_secret           — base32-encoded TOTP secret, generated server-
--                           side by otplib at setup. NULL when 2FA is not
--                           configured. Read-only after enable; rotating
--                           it requires the user to re-enroll.
--
--   totp_enabled          — gates the login challenge. Setup writes the
--                           secret but leaves enabled=FALSE until the
--                           user successfully proves they can read codes
--                           from their authenticator. Toggle stays in
--                           sync with what /auth/2fa/disable does.
--
--   totp_recovery_codes   — 10 one-time-use codes returned in plaintext
--                           exactly ONCE at setup. Stored hashed so a
--                           database leak doesn't compromise login. Each
--                           successful use removes the matching hash
--                           from the array (single-use). User can fall
--                           back to one of these if their authenticator
--                           is unreachable (lost phone, factory reset).
--
-- Migration is idempotent — if any column already exists the ALTER is a
-- no-op, safe to re-run on prod and on a fresh dev DB.

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled         BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_codes  TEXT[]  DEFAULT '{}';
