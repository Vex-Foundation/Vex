-- 081_lighter_order_execution_intents.sql — Lighter order execution intent store.
--
-- Purpose: persist the exact approval-gated Lighter order intent between the
-- preview gate and any future signer/sendTx path. A row here is a durable
-- promise that Vex knows which live preview, account, API-key index, and vault
-- credential reference will be used if the user approves.
--
-- Production boundary:
--   - This table stores opaque encrypted-vault references only. It must never
--     store API private keys, read-only auth tokens, signatures, signed
--     transaction JSON, provider raw auth errors, or sendTx payloads.
--   - A row authorizes nothing by itself. Signing and submission still require
--     a recorded user approval, a fresh nonce reservation, privileged runtime
--     signing, and provider outcome repair.
--   - Every lookup is session-scoped and environment-scoped so execution
--     intents cannot replay across sessions or Core/RHC.

CREATE TABLE IF NOT EXISTS lighter_order_execution_intents (
  intent_id                  TEXT PRIMARY KEY,
  session_id                 TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  preview_id                 TEXT NOT NULL REFERENCES lighter_order_previews(preview_id) ON DELETE RESTRICT,
  protocol_execution_id      BIGINT REFERENCES protocol_executions(id) ON DELETE RESTRICT,
  approval_id                TEXT UNIQUE REFERENCES approval_queue(id) ON DELETE SET NULL,
  match_hash                 TEXT NOT NULL CHECK (match_hash ~ '^[0-9a-f]{64}$'),
  environment                TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index              BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index              INTEGER NOT NULL CHECK (api_key_index >= 4 AND api_key_index <= 254),
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
  credential_ref_json        JSONB NOT NULL CHECK (jsonb_typeof(credential_ref_json) = 'object'),
  approval_status            TEXT NOT NULL DEFAULT 'approval_pending' CHECK (
    approval_status IN ('approval_pending','approved','rejected','expired')
  ),
  execution_state            TEXT NOT NULL DEFAULT 'approval_pending' CHECK (
    execution_state IN (
      'previewed',
      'approval_pending',
      'signed',
      'submitted',
      'api_accepted',
      'sequencer_pending',
      'open',
      'partially_filled',
      'filled',
      'canceled',
      'rejected',
      'ambiguous'
    )
  ),
  decision_reason            TEXT,
  decided_at                 TIMESTAMPTZ,
  nonce_reservation_id       TEXT,
  nonce_value                TEXT CHECK (nonce_value IS NULL OR nonce_value ~ '^[0-9]+$'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                 TIMESTAMPTZ NOT NULL,
  CHECK (
    (approval_status = 'approval_pending' AND decided_at IS NULL)
    OR (approval_status <> 'approval_pending' AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_live_preview
  ON lighter_order_execution_intents (session_id, preview_id)
  WHERE approval_status IN ('approval_pending','approved');

CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_session
  ON lighter_order_execution_intents (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_approval
  ON lighter_order_execution_intents (approval_id)
  WHERE approval_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_execution
  ON lighter_order_execution_intents (execution_state, updated_at DESC);
