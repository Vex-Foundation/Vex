-- 080_lighter_order_previews.sql — Lighter order preview gate store.
--
-- Purpose: every successful `lighter.order.preview` records one exact,
-- session-scoped order identity before any future create-order path can exist.
-- This is deliberately separate from `swap_prequotes`: Lighter is an exchange
-- order book, not a swap venue, and the identity binds exchange-specific fields
-- such as account index, API-key index, order type, time-in-force, reduce-only,
-- expiry, and client-order-index policy.
--
-- Production boundary:
--   - This table stores previews only. It never stores API private keys,
--     read-only auth tokens, signatures, signed transaction JSON, provider raw
--     auth errors, or `sendTx` payloads.
--   - A preview row authorizes nothing by itself. A later create-order gate must
--     re-compute the same match_hash and require a fresh matching row.
--   - Every lookup must include session_id and environment so previews cannot
--     replay across sessions or Core/RHC.

CREATE TABLE IF NOT EXISTS lighter_order_previews (
  preview_id                 TEXT PRIMARY KEY,
  session_id                 TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  match_hash                 TEXT NOT NULL CHECK (match_hash ~ '^[0-9a-f]{64}$'),
  environment                TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index              BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index              INTEGER CHECK (api_key_index IS NULL OR (api_key_index >= 0 AND api_key_index <= 255)),
  market_index               INTEGER NOT NULL CHECK (market_index >= 0 AND market_index <= 65535),
  side                       TEXT NOT NULL CHECK (side IN ('buy','sell')),
  base_amount_integer        TEXT NOT NULL CHECK (base_amount_integer ~ '^[1-9][0-9]*$'),
  price_integer              TEXT NOT NULL CHECK (price_integer ~ '^[1-9][0-9]*$'),
  order_type                 TEXT NOT NULL CHECK (order_type IN ('limit','market')),
  time_in_force              TEXT NOT NULL CHECK (time_in_force IN ('good-till-time','immediate-or-cancel','post-only')),
  reduce_only                BOOLEAN NOT NULL,
  trigger_price_integer      TEXT,
  order_expiry_ms            BIGINT NOT NULL,
  client_order_index_policy  TEXT NOT NULL,
  provider_version           TEXT NOT NULL,
  preview_json               JSONB NOT NULL CHECK (jsonb_typeof(preview_json) = 'object'),
  live_source_json           JSONB NOT NULL CHECK (jsonb_typeof(live_source_json) = 'object'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                 TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lighter_order_previews_match
  ON lighter_order_previews (session_id, environment, match_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lighter_order_previews_session
  ON lighter_order_previews (session_id, created_at DESC);
