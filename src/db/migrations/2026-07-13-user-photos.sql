-- ═══════════════════════════════════════════════════════════════
--  Migration: 2026-07-13 user_photos — multi-photo profiles
--
--  Adds a per-user photo gallery (up to 6, enforced in the route). The
--  legacy single users.photo_url stays authoritative for the PRIMARY photo
--  and is kept in sync with the position-0 gallery photo by the routes
--  (POST/DELETE/PATCH /users/me/photos), so every existing consumer of
--  users.photo_url keeps working with no change.
--
--    position   — 0-based display order; position 0 is the primary photo
--    public_id  — Cloudinary asset id, so DELETE can remove the blob
--
--  gen_random_uuid() needs pgcrypto (most tables use uuid-ossp's
--  uuid_generate_v4(); this one follows the spec and uses pgcrypto).
--
--  Apply via Railway → Postgres → Data tab. IF NOT EXISTS makes it
--  safe to re-run. Also mirrored into migrate_missing.sql (boot-applied)
--  and schema.sql (fresh installs).
-- ═══════════════════════════════════════════════════════════════

BEGIN;

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

COMMIT;
