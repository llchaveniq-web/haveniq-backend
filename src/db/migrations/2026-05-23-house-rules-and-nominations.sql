-- ═══════════════════════════════════════════════════════════════
--  Migration: 2026-05-23 house_rules + best_roommate_nominations
--
--  Two tables backing the House Rules screen and the Best Roommate
--  nomination submission flow. Both are scoped per-user — full
--  multi-user voting / household sharing comes later.
--
--  Apply via Railway → Postgres → Data tab. IF NOT EXISTS makes this
--  safe to re-run.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ── House Rules ─────────────────────────────────────────────────────────
-- One row per rule the user has drafted. Single-user scoped for now;
-- multi-roommate voting / household sharing is a future expansion.
-- thumbs_up is a personal "this matters to me" counter incremented by
-- the owner (we don't track which user thumbed it — there's only one).
CREATE TABLE IF NOT EXISTS house_rules (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  text          TEXT NOT NULL,
  why           TEXT,
  vote_required BOOLEAN NOT NULL DEFAULT TRUE,
  thumbs_up     INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_house_rules_user
  ON house_rules (user_id, created_at DESC);

-- ── Best Roommate nominations ───────────────────────────────────────────
-- User-submitted nominations of someone they think deserves the "best
-- roommate" award. Separate from the /best-roommate/vote endpoint (which
-- registers a vote for an existing nominee). qualities + relationship
-- are TEXT[] arrays so we don't lose the structured chip selections.
CREATE TABLE IF NOT EXISTS best_roommate_nominations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nominator_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nominee_name    TEXT NOT NULL,
  why_best        TEXT NOT NULL,
  specific_story  TEXT,
  qualities       TEXT[] NOT NULL DEFAULT '{}',
  relationship    TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brn_nominator
  ON best_roommate_nominations (nominator_id, created_at DESC);

COMMIT;
