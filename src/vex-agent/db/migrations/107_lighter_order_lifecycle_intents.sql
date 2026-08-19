-- 107_lighter_order_lifecycle_intents.sql — durable Phase 2 order actions.
--
-- Exact provider order identities remain decimal TEXT so JavaScript never
-- rounds an order_index. This table stores only structural, non-secret facts;
-- signatures and signed txInfo are intentionally excluded.

CREATE TABLE IF NOT EXISTS lighter_order_lifecycle_intents (
  intent_id                    TEXT PRIMARY KEY,
  session_id                   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  protocol_execution_id        BIGINT REFERENCES protocol_executions(id) ON DELETE RESTRICT,
  approval_id                  TEXT UNIQUE REFERENCES approval_queue(id) ON DELETE SET NULL,
  match_hash                   TEXT NOT NULL CHECK (match_hash ~ '^[0-9a-f]{64}$'),
  environment                  TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index                BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index                INTEGER NOT NULL CHECK (api_key_index >= 4 AND api_key_index <= 254),
  action_type                  TEXT NOT NULL CHECK (
    action_type IN ('cancel_one','modify','cancel_all','close_position')
  ),
  market_index                 INTEGER CHECK (
    market_index IS NULL OR market_index BETWEEN 0 AND 65535
  ),
  provider_order_id            TEXT CHECK (
    provider_order_id IS NULL OR (
      provider_order_id ~ '^[1-9][0-9]*$'
      AND provider_order_id::NUMERIC <= 1152921504606846975
    )
  ),
  requested_base_amount_integer TEXT CHECK (
    requested_base_amount_integer IS NULL OR requested_base_amount_integer ~ '^[1-9][0-9]*$'
  ),
  requested_price_integer      TEXT CHECK (
    requested_price_integer IS NULL OR requested_price_integer ~ '^[1-9][0-9]*$'
  ),
  requested_side               TEXT CHECK (requested_side IS NULL OR requested_side IN ('buy','sell')),
  reduce_only                  BOOLEAN NOT NULL DEFAULT FALSE,
  provider_snapshot_json       JSONB NOT NULL CHECK (jsonb_typeof(provider_snapshot_json) = 'object'),
  credential_ref_json          JSONB NOT NULL CHECK (jsonb_typeof(credential_ref_json) = 'object'),
  approval_status              TEXT NOT NULL DEFAULT 'approval_pending' CHECK (
    approval_status IN ('approval_pending','approved','rejected','expired')
  ),
  execution_state              TEXT NOT NULL DEFAULT 'approval_pending' CHECK (
    execution_state IN (
      'approval_pending','approved','pre_submit_revalidated','nonce_reserved',
      'signed','submission_staged','api_accepted','sequencer_pending',
      'completed','rejected','expired','ambiguous'
    )
  ),
  decision_reason              TEXT,
  decided_at                   TIMESTAMPTZ,
  pre_submit_revalidation_json JSONB CHECK (
    pre_submit_revalidation_json IS NULL OR jsonb_typeof(pre_submit_revalidation_json) = 'object'
  ),
  pre_submit_revalidated_at    TIMESTAMPTZ,
  nonce_reservation_id         TEXT,
  nonce_value                  TEXT CHECK (nonce_value IS NULL OR nonce_value ~ '^[0-9]+$'),
  signer_expiry_ms             BIGINT,
  signer_tx_hash               TEXT,
  submitted_tx_hash            TEXT,
  submit_code                  INTEGER,
  submit_message               TEXT,
  predicted_execution_time_ms  INTEGER,
  volume_quota_remaining       TEXT,
  provider_outcome_json        JSONB CHECK (
    provider_outcome_json IS NULL OR jsonb_typeof(provider_outcome_json) = 'object'
  ),
  provider_outcome_checked_at  TIMESTAMPTZ,
  ambiguous_reason             TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                   TIMESTAMPTZ NOT NULL,
  CHECK (
    (approval_status = 'approval_pending' AND decided_at IS NULL)
    OR (approval_status <> 'approval_pending' AND decided_at IS NOT NULL)
  ),
  CHECK (
    (action_type IN ('cancel_one','modify') AND market_index IS NOT NULL AND provider_order_id IS NOT NULL)
    OR (action_type = 'cancel_all' AND market_index IS NULL AND provider_order_id IS NULL)
    OR (action_type = 'close_position' AND market_index IS NOT NULL AND provider_order_id IS NULL)
  ),
  CHECK (
    (action_type = 'modify' AND requested_base_amount_integer IS NOT NULL AND requested_price_integer IS NOT NULL)
    OR (action_type <> 'modify')
  ),
  CHECK (
    (action_type = 'close_position' AND requested_base_amount_integer IS NOT NULL
      AND requested_price_integer IS NOT NULL AND requested_side IS NOT NULL AND reduce_only)
    OR (action_type <> 'close_position')
  ),
  CHECK (action_type = 'close_position' OR NOT reduce_only)
);

CREATE INDEX IF NOT EXISTS idx_lighter_order_lifecycle_session
  ON lighter_order_lifecycle_intents (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lighter_order_lifecycle_repair
  ON lighter_order_lifecycle_intents (execution_state, updated_at)
  WHERE execution_state IN ('nonce_reserved','signed','submission_staged','api_accepted','sequencer_pending','ambiguous');

CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_order_lifecycle_live_order_action
  ON lighter_order_lifecycle_intents (environment, account_index, action_type, market_index, provider_order_id)
  WHERE action_type IN ('cancel_one','modify')
    AND execution_state NOT IN ('completed','rejected','expired');

CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_order_lifecycle_live_cancel_all
  ON lighter_order_lifecycle_intents (environment, account_index)
  WHERE action_type = 'cancel_all'
    AND execution_state NOT IN ('completed','rejected','expired');

CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_order_lifecycle_live_close
  ON lighter_order_lifecycle_intents (environment, account_index, market_index)
  WHERE action_type = 'close_position'
    AND execution_state NOT IN ('completed','rejected','expired');
