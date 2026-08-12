-- 078_lighter_nonce_state.sql — Lighter API-key nonce tracking.
--
-- Purpose: record public Lighter API-key nonce observations and reserve one
-- exact nonce before a future signer path can submit an order. This table is
-- execution infrastructure only. It stores no API private keys, read-only auth
-- tokens, signatures, signed payloads, provider auth errors, or `sendTx`
-- bodies.
--
-- Safety boundary:
--   - Nonces are stored as decimal TEXT so future code never depends on a
--     JavaScript number once the value crosses the safe-integer boundary.
--   - Reservations are keyed by (environment, account_index, api_key_index).
--   - A future submit path must persist a reservation before signing/submitting
--     and must move ambiguous provider outcomes to `ambiguous`, not invite a
--     blind retry.

CREATE TABLE IF NOT EXISTS lighter_nonce_state (
  environment                  TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index                BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index                INTEGER NOT NULL CHECK (api_key_index >= 0 AND api_key_index <= 255),
  provider_nonce               TEXT NOT NULL CHECK (provider_nonce ~ '^[0-9]+$'),
  public_key                   TEXT NOT NULL CHECK (length(public_key) > 0),
  provider_transaction_time    TEXT CHECK (provider_transaction_time IS NULL OR provider_transaction_time ~ '^[0-9]+$'),
  status                       TEXT NOT NULL DEFAULT 'observed'
    CHECK (status IN ('observed','reserved','submitted','ambiguous')),
  reserved_nonce               TEXT CHECK (reserved_nonce IS NULL OR reserved_nonce ~ '^[0-9]+$'),
  reservation_id               TEXT,
  source                       TEXT NOT NULL DEFAULT 'live_lighter_public_api',
  observed_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, account_index, api_key_index),
  CHECK (
    (status = 'observed' AND reserved_nonce IS NULL AND reservation_id IS NULL)
    OR
    (status IN ('reserved','submitted','ambiguous') AND reserved_nonce IS NOT NULL AND reservation_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_lighter_nonce_state_status
  ON lighter_nonce_state (status, updated_at DESC);
