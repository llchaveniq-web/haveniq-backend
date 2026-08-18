-- ═══════════════════════════════════════════════════════════════
--  Migration: 2026-05-23 Plaid Connect tables
--
--  Adds:
--    • plaid_items — one row per user-connected bank account
--                   (the Plaid "item" is the connection itself, not the
--                   accounts under it — Plaid jargon).
--
--  Apply via Railway → Postgres → Data tab. Multi-statement DDL works.
--  IF NOT EXISTS makes this safe to re-run.
--
--  Security note: access_token is a server-side secret. Never expose it
--  via the API. Encrypted at rest at the application layer (AES-256-GCM,
--  see lib/plaidCrypto.js) whenever PLAID_TOKEN_ENC_KEY is set on Railway —
--  no schema change needed, the column stays TEXT and transparently holds
--  either a legacy plaintext value or an `enc:v1:...` ciphertext. With no
--  key configured, reads/writes fall back to plaintext (deploy-safe, not a
--  security default — set the key before any real Plaid credentials go live).
-- ═══════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS plaid_items (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Plaid's own identifier for the connection (one user can have multiple
  -- — e.g. they connect Chase AND Bank of America). We use this when
  -- handling webhooks from Plaid.
  plaid_item_id     TEXT NOT NULL UNIQUE,
  -- Server-side secret used to call Plaid APIs on the user's behalf
  -- (asset reports, income verification, transactions). NEVER expose.
  access_token      TEXT NOT NULL,
  -- Display fields — safe to send to the client.
  institution_name  TEXT,
  institution_id    TEXT,
  -- Last 4 of the primary account number, masked the same way Plaid
  -- shows it. Used for "Connected: Chase •••• 1234" UI.
  account_mask      TEXT,
  -- Did the user revoke the connection from inside Plaid Link? Set true
  -- via the ITEM_REMOVED webhook. We keep the row for audit.
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plaid_items_user
  ON plaid_items (user_id) WHERE is_active = TRUE;

COMMIT;
