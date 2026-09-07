-- Native OCO protection for one existing perpetual position. The two child
-- previews remain independently exact; this row binds them to one approval,
-- one nonce, one TxType 28 submission, and one evidence-only group outcome.

CREATE TABLE IF NOT EXISTS lighter_oco_execution_intents (
  intent_id                         TEXT PRIMARY KEY,
  session_id                        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  approval_id                       TEXT UNIQUE REFERENCES approval_queue(id) ON DELETE SET NULL,
  match_hash                        TEXT NOT NULL CHECK (match_hash ~ '^[0-9a-f]{64}$'),
  environment                       TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index                     BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index                     INTEGER NOT NULL CHECK (api_key_index BETWEEN 4 AND 254),
  market_index                      INTEGER NOT NULL CHECK (market_index BETWEEN 0 AND 254),
  side                              TEXT NOT NULL CHECK (side IN ('buy','sell')),
  base_amount_integer               TEXT NOT NULL CHECK (base_amount_integer ~ '^[1-9][0-9]*$'),
  stop_loss_preview_id              TEXT NOT NULL REFERENCES lighter_order_previews(preview_id) ON DELETE RESTRICT,
  stop_loss_match_hash              TEXT NOT NULL CHECK (stop_loss_match_hash ~ '^[0-9a-f]{64}$'),
  stop_loss_price_integer           TEXT NOT NULL CHECK (stop_loss_price_integer ~ '^[1-9][0-9]*$'),
  stop_loss_trigger_price_integer   TEXT NOT NULL CHECK (stop_loss_trigger_price_integer ~ '^[1-9][0-9]*$'),
  take_profit_preview_id            TEXT NOT NULL REFERENCES lighter_order_previews(preview_id) ON DELETE RESTRICT,
  take_profit_match_hash            TEXT NOT NULL CHECK (take_profit_match_hash ~ '^[0-9a-f]{64}$'),
  take_profit_price_integer         TEXT NOT NULL CHECK (take_profit_price_integer ~ '^[1-9][0-9]*$'),
  take_profit_trigger_price_integer TEXT NOT NULL CHECK (take_profit_trigger_price_integer ~ '^[1-9][0-9]*$'),
  order_expiry_ms                   BIGINT NOT NULL,
  client_order_index_policy         TEXT NOT NULL,
  provider_version                  TEXT NOT NULL,
  preview_json                      JSONB NOT NULL CHECK (jsonb_typeof(preview_json) = 'object'),
  live_source_json                  JSONB NOT NULL CHECK (jsonb_typeof(live_source_json) = 'object'),
  credential_ref_json               JSONB NOT NULL CHECK (jsonb_typeof(credential_ref_json) = 'object'),
  approval_status                   TEXT NOT NULL DEFAULT 'approval_pending' CHECK (
    approval_status IN ('approval_pending','approved','rejected','expired')
  ),
  execution_state                   TEXT NOT NULL DEFAULT 'approval_pending' CHECK (
    execution_state IN ('approval_pending','signed','submitted','api_accepted',
      'sequencer_pending','active','resolved','rejected','ambiguous')
  ),
  decision_reason                   TEXT,
  decided_at                        TIMESTAMPTZ,
  pre_submit_revalidation_json      JSONB CHECK (
    pre_submit_revalidation_json IS NULL OR jsonb_typeof(pre_submit_revalidation_json) = 'object'
  ),
  pre_submit_revalidated_at         TIMESTAMPTZ,
  nonce_reservation_id              TEXT,
  nonce_value                       TEXT CHECK (nonce_value IS NULL OR nonce_value ~ '^[0-9]+$'),
  stop_loss_client_order_index      TEXT CHECK (stop_loss_client_order_index IS NULL OR stop_loss_client_order_index ~ '^[1-9][0-9]*$'),
  take_profit_client_order_index    TEXT CHECK (take_profit_client_order_index IS NULL OR take_profit_client_order_index ~ '^[1-9][0-9]*$'),
  signer_tx_hash                    TEXT,
  submitted_tx_hash                 TEXT,
  submit_code                       INTEGER,
  submit_message                    TEXT,
  predicted_execution_time_ms       INTEGER,
  volume_quota_remaining            TEXT,
  provider_outcome_json             JSONB CHECK (
    provider_outcome_json IS NULL OR jsonb_typeof(provider_outcome_json) = 'object'
  ),
  provider_outcome_checked_at       TIMESTAMPTZ,
  ambiguous_reason                  TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                        TIMESTAMPTZ NOT NULL,
  CHECK (stop_loss_preview_id <> take_profit_preview_id),
  CHECK (stop_loss_match_hash <> take_profit_match_hash),
  CHECK (
    (approval_status = 'approval_pending' AND decided_at IS NULL)
    OR (approval_status <> 'approval_pending' AND decided_at IS NOT NULL)
  ),
  CHECK (
    (stop_loss_client_order_index IS NULL AND take_profit_client_order_index IS NULL)
    OR (stop_loss_client_order_index IS NOT NULL AND take_profit_client_order_index IS NOT NULL
      AND stop_loss_client_order_index <> take_profit_client_order_index)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_oco_live_match
  ON lighter_oco_execution_intents (session_id, match_hash)
  WHERE approval_status IN ('approval_pending','approved');

CREATE INDEX IF NOT EXISTS idx_lighter_oco_repair
  ON lighter_oco_execution_intents (execution_state, updated_at)
  WHERE execution_state IN ('signed','submitted','api_accepted','sequencer_pending','ambiguous');

CREATE INDEX IF NOT EXISTS idx_lighter_oco_client_orders
  ON lighter_oco_execution_intents (
    environment, account_index, stop_loss_client_order_index, take_profit_client_order_index
  ) WHERE stop_loss_client_order_index IS NOT NULL;
