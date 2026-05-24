-- ═══════════════════════════════════════════════════════════════
--  Migration: 2026-05-24 user_blocks + user_reports
--
--  Two tables backing the safety surface:
--    • user_blocks   — one row per (blocker, blocked) pair. Used by the
--                      match feed + messaging to filter out anyone the
--                      current user blocked, in either direction.
--    • user_reports  — append-only log of every report filed. Founder
--                      reviews these manually until we have a real ops
--                      team. Email alert fires on each insert.
--
--  Apply via Railway → Postgres → Data tab. IF NOT EXISTS makes this
--  safe to re-run.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS user_blocks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_blocks_unique UNIQUE (blocker_id, blocked_id),
  CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks (blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks (blocked_id);

CREATE TABLE IF NOT EXISTS user_reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- reporter_id is nullable so anonymous reports (anonymous-report.tsx)
  -- can be filed without a user-row attribution.
  reporter_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  -- reported_id is nullable for general safety reports that aren't
  -- about a specific user.
  reported_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  category      TEXT NOT NULL,         -- e.g. 'harassment', 'spam', 'fake_profile', 'safety'
  severity      TEXT NOT NULL DEFAULT 'medium',  -- 'low' | 'medium' | 'high' | 'urgent'
  reason        TEXT,
  details       TEXT,                  -- free-text from the reporter
  -- Status flow: open → reviewed → (actioned | dismissed)
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

COMMIT;
