-- 102_lighter_core_withdrawals.sql — durable approval-gated Core USDC withdrawals.
--
-- Stores only public identity and evidence. API private keys, auth tokens,
-- signatures, and signed tx_info are forbidden from this table.

CREATE TABLE IF NOT EXISTS lighter_withdrawal_intents (
  intent_id                    TEXT PRIMARY KEY,
  preview_id                   TEXT NOT NULL UNIQUE,
  session_id                   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  protocol_execution_id        BIGINT REFERENCES protocol_executions(id) ON DELETE RESTRICT,
  approval_id                  TEXT UNIQUE REFERENCES approval_queue(id) ON DELETE SET NULL,
  match_hash                   TEXT NOT NULL CHECK (match_hash ~ '^[0-9a-f]{64}$'),
  environment                  TEXT NOT NULL CHECK (environment = 'core'),
  operation_class              TEXT NOT NULL CHECK (operation_class = 'secure_l2_withdrawal'),
  endpoint                     TEXT NOT NULL,
  signing_chain_id             INTEGER NOT NULL CHECK (signing_chain_id = 304),
  settlement_chain_id          INTEGER NOT NULL CHECK (settlement_chain_id = 1),
  settlement_network_name      TEXT NOT NULL CHECK (settlement_network_name = 'Ethereum mainnet'),
  account_index                BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index                INTEGER NOT NULL CHECK (api_key_index >= 4 AND api_key_index <= 254),
  wallet_address               TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9A-Fa-f]{40}$'),
  destination_address          TEXT NOT NULL CHECK (destination_address ~ '^0x[0-9A-Fa-f]{40}$'),
  credential_ref_json          JSONB NOT NULL CHECK (jsonb_typeof(credential_ref_json) = 'object'),
  asset_index                  INTEGER NOT NULL CHECK (asset_index = 3),
  asset_symbol                 TEXT NOT NULL CHECK (asset_symbol = 'USDC'),
  asset_decimals               INTEGER NOT NULL CHECK (asset_decimals = 6),
  settlement_token_address     TEXT NOT NULL CHECK (settlement_token_address ~ '^0x[0-9A-Fa-f]{40}$'),
  route_type                   INTEGER NOT NULL CHECK (route_type = 0),
  amount_units                 TEXT NOT NULL CHECK (amount_units ~ '^[1-9][0-9]*$'),
  minimum_withdrawal_units     TEXT NOT NULL CHECK (minimum_withdrawal_units ~ '^[1-9][0-9]*$'),
  available_balance_units      TEXT NOT NULL CHECK (available_balance_units ~ '^[0-9]+$'),
  collateral_units             TEXT NOT NULL CHECK (collateral_units ~ '^[0-9]+$'),
  initial_margin_units         TEXT NOT NULL CHECK (initial_margin_units ~ '^[0-9]+$'),
  maintenance_margin_units     TEXT NOT NULL CHECK (maintenance_margin_units ~ '^[0-9]+$'),
  pending_order_count          INTEGER NOT NULL CHECK (pending_order_count >= 0),
  open_position_count          INTEGER NOT NULL CHECK (open_position_count >= 0),
  active_order_count           INTEGER NOT NULL CHECK (active_order_count >= 0),
  gateway_address              TEXT NOT NULL CHECK (gateway_address ~ '^0x[0-9A-Fa-f]{40}$'),
  gateway_implementation       TEXT NOT NULL CHECK (gateway_implementation ~ '^0x[0-9A-Fa-f]{40}$'),
  gateway_code_hash            TEXT NOT NULL CHECK (gateway_code_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  settlement_token_code_hash   TEXT NOT NULL CHECK (settlement_token_code_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  preflight_json               JSONB NOT NULL CHECK (jsonb_typeof(preflight_json) = 'object'),
  preflight_observed_at        TIMESTAMPTZ NOT NULL,
  pre_submit_revalidation_json JSONB CHECK (pre_submit_revalidation_json IS NULL OR jsonb_typeof(pre_submit_revalidation_json) = 'object'),
  pre_submit_revalidated_at    TIMESTAMPTZ,
  withdrawal_delay_seconds     INTEGER NOT NULL CHECK (withdrawal_delay_seconds >= 0),
  delay_observed_at            TIMESTAMPTZ NOT NULL,
  approval_status              TEXT NOT NULL DEFAULT 'approval_pending'
    CHECK (approval_status IN ('approval_pending','approved','rejected','expired')),
  execution_state              TEXT NOT NULL DEFAULT 'approval_pending'
    CHECK (execution_state IN (
      'approval_pending','approved','nonce_reserved','signed','submission_staged',
      'api_accepted','l2_pending','l2_executed','secure_waiting','claimable',
      'auto_claim_observed','manual_claim_prepared','manual_claim_approved',
      'manual_claim_staged','manual_claim_submitted','destination_confirmed',
      'rejected','failed','refunded','expired','ambiguous'
    )),
  decision_reason              TEXT,
  decided_at                   TIMESTAMPTZ,
  nonce_reservation_id         TEXT,
  nonce_value                  TEXT CHECK (nonce_value IS NULL OR nonce_value ~ '^[0-9]+$'),
  signer_tx_hash               TEXT,
  submitted_tx_hash            TEXT,
  signer_expiry_ms             BIGINT,
  submit_code                  INTEGER,
  submit_message               TEXT,
  predicted_execution_time_ms  INTEGER,
  volume_quota_remaining       TEXT CHECK (volume_quota_remaining IS NULL OR volume_quota_remaining ~ '^[0-9]+$'),
  provider_tx_status           INTEGER,
  provider_tx_evidence_json    JSONB CHECK (provider_tx_evidence_json IS NULL OR jsonb_typeof(provider_tx_evidence_json) = 'object'),
  withdrawal_history_id        TEXT,
  withdrawal_history_status    TEXT CHECK (
    withdrawal_history_status IS NULL OR withdrawal_history_status IN ('failed','pending','claimable','refunded','completed')
  ),
  withdrawal_history_json      JSONB CHECK (withdrawal_history_json IS NULL OR jsonb_typeof(withdrawal_history_json) = 'object'),
  pending_balance_units        TEXT CHECK (pending_balance_units IS NULL OR pending_balance_units ~ '^[0-9]+$'),
  ambiguous_reason             TEXT,
  claim_mode                   TEXT CHECK (claim_mode IS NULL OR claim_mode IN ('auto','manual','legacy')),
  claim_approval_id            TEXT UNIQUE REFERENCES approval_queue(id) ON DELETE SET NULL,
  claim_tx_hash                TEXT,
  claim_replacement_tx_hash    TEXT,
  destination_tx_hash          TEXT,
  destination_block_number     TEXT CHECK (destination_block_number IS NULL OR destination_block_number ~ '^[0-9]+$'),
  destination_block_hash       TEXT,
  destination_confirmations    INTEGER CHECK (destination_confirmations IS NULL OR destination_confirmations >= 0),
  destination_evidence_json    JSONB CHECK (destination_evidence_json IS NULL OR jsonb_typeof(destination_evidence_json) = 'object'),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                   TIMESTAMPTZ NOT NULL,
  CHECK (LOWER(wallet_address) = LOWER(destination_address)),
  CHECK (
    (approval_status = 'approval_pending' AND decided_at IS NULL)
    OR (approval_status <> 'approval_pending' AND decided_at IS NOT NULL)
  ),
  CHECK (
    (nonce_reservation_id IS NULL AND nonce_value IS NULL)
    OR (nonce_reservation_id IS NOT NULL AND nonce_value IS NOT NULL)
  ),
  CHECK (
    signer_tx_hash IS NULL
    OR (nonce_reservation_id IS NOT NULL AND nonce_value IS NOT NULL AND signer_expiry_ms IS NOT NULL)
  ),
  CHECK (
    submitted_tx_hash IS NULL
    OR (signer_tx_hash IS NOT NULL AND submit_code IS NOT NULL)
  ),
  CHECK (
    (pre_submit_revalidation_json IS NULL AND pre_submit_revalidated_at IS NULL)
    OR (pre_submit_revalidation_json IS NOT NULL AND pre_submit_revalidated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lighter_withdrawal_nonterminal_scope
  ON lighter_withdrawal_intents (environment, account_index, asset_index, route_type)
  WHERE execution_state NOT IN ('destination_confirmed','rejected','failed','refunded','expired');

CREATE INDEX IF NOT EXISTS idx_lighter_withdrawal_session
  ON lighter_withdrawal_intents (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lighter_withdrawal_reconciliation
  ON lighter_withdrawal_intents (execution_state, updated_at ASC)
  WHERE execution_state NOT IN ('destination_confirmed','rejected','failed','refunded','expired');
