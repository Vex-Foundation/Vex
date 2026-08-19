-- 104_lighter_withdrawal_manual_claims.sql — separate approval-gated Ethereum claims.
--
-- A claim attempt stores public transaction identity and evidence only. Wallet
-- private keys, signatures, and serialized signed transactions are forbidden.

ALTER TABLE lighter_evm_execution_leases
  DROP CONSTRAINT IF EXISTS lighter_evm_execution_leases_intent_id_fkey;

CREATE TABLE IF NOT EXISTS lighter_withdrawal_claim_attempts (
  claim_id                       TEXT PRIMARY KEY,
  withdrawal_intent_id           TEXT NOT NULL REFERENCES lighter_withdrawal_intents(intent_id) ON DELETE CASCADE,
  session_id                     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  preview_id                     TEXT NOT NULL UNIQUE,
  approval_id                    TEXT UNIQUE REFERENCES approval_queue(id) ON DELETE SET NULL,
  match_hash                     TEXT NOT NULL CHECK (match_hash ~ '^[0-9a-f]{64}$'),
  operation_class                TEXT NOT NULL CHECK (operation_class = 'manual_core_usdc_claim'),
  settlement_chain_id            INTEGER NOT NULL CHECK (settlement_chain_id = 1),
  settlement_network_name        TEXT NOT NULL CHECK (settlement_network_name = 'Ethereum mainnet'),
  wallet_address                 TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9A-Fa-f]{40}$'),
  owner_address                  TEXT NOT NULL CHECK (owner_address ~ '^0x[0-9A-Fa-f]{40}$'),
  gateway_address                TEXT NOT NULL CHECK (gateway_address ~ '^0x[0-9A-Fa-f]{40}$'),
  gateway_implementation         TEXT NOT NULL CHECK (gateway_implementation ~ '^0x[0-9A-Fa-f]{40}$'),
  gateway_code_hash              TEXT NOT NULL CHECK (gateway_code_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  settlement_token_address       TEXT NOT NULL CHECK (settlement_token_address ~ '^0x[0-9A-Fa-f]{40}$'),
  settlement_token_code_hash     TEXT NOT NULL CHECK (settlement_token_code_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  asset_index                    INTEGER NOT NULL CHECK (asset_index = 3),
  asset_symbol                   TEXT NOT NULL CHECK (asset_symbol = 'USDC'),
  asset_decimals                 INTEGER NOT NULL CHECK (asset_decimals = 6),
  amount_units                   TEXT NOT NULL CHECK (amount_units ~ '^[1-9][0-9]*$'),
  calldata                       TEXT NOT NULL CHECK (calldata ~ '^0x[0-9A-Fa-f]+$'),
  value_wei                      TEXT NOT NULL CHECK (value_wei = '0'),
  preflight_json                 JSONB NOT NULL CHECK (jsonb_typeof(preflight_json) = 'object'),
  preflight_observed_at          TIMESTAMPTZ NOT NULL,
  preflight_block_number         TEXT NOT NULL CHECK (preflight_block_number ~ '^[0-9]+$'),
  native_balance_wei             TEXT NOT NULL CHECK (native_balance_wei ~ '^[0-9]+$'),
  gas_estimate                   TEXT NOT NULL CHECK (gas_estimate ~ '^[1-9][0-9]*$'),
  gas_limit                      TEXT NOT NULL CHECK (gas_limit ~ '^[1-9][0-9]*$'),
  quoted_max_fee_per_gas_wei     TEXT NOT NULL CHECK (quoted_max_fee_per_gas_wei ~ '^[1-9][0-9]*$'),
  quoted_priority_fee_per_gas_wei TEXT NOT NULL CHECK (quoted_priority_fee_per_gas_wei ~ '^[0-9]+$'),
  fee_ceiling_per_gas_wei        TEXT NOT NULL CHECK (fee_ceiling_per_gas_wei ~ '^[1-9][0-9]*$'),
  priority_fee_ceiling_wei       TEXT NOT NULL CHECK (priority_fee_ceiling_wei ~ '^[0-9]+$'),
  network_fee_ceiling_wei        TEXT NOT NULL CHECK (network_fee_ceiling_wei ~ '^[1-9][0-9]*$'),
  state                          TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN (
    'prepared','approved','staged','submitted','confirming','confirmed',
    'reverted','rejected','expired','ambiguous'
  )),
  decision_reason                TEXT,
  decided_at                     TIMESTAMPTZ,
  tx_hash                        TEXT,
  replacement_tx_hash            TEXT,
  from_address                   TEXT CHECK (from_address IS NULL OR from_address ~ '^0x[0-9A-Fa-f]{40}$'),
  nonce                          INTEGER CHECK (nonce IS NULL OR nonce >= 0),
  receipt_json                   JSONB CHECK (receipt_json IS NULL OR jsonb_typeof(receipt_json) = 'object'),
  ambiguous_reason               TEXT,
  staged_at                      TIMESTAMPTZ,
  submitted_at                   TIMESTAMPTZ,
  confirmed_at                   TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                     TIMESTAMPTZ NOT NULL,
  CHECK (LOWER(wallet_address) = LOWER(owner_address)),
  CHECK (quoted_priority_fee_per_gas_wei::numeric <= quoted_max_fee_per_gas_wei::numeric),
  CHECK (priority_fee_ceiling_wei::numeric <= fee_ceiling_per_gas_wei::numeric),
  CHECK (network_fee_ceiling_wei::numeric = gas_limit::numeric * fee_ceiling_per_gas_wei::numeric),
  CHECK ((tx_hash IS NULL AND from_address IS NULL AND nonce IS NULL) OR (tx_hash IS NOT NULL AND from_address IS NOT NULL AND nonce IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lighter_withdrawal_live_claim
  ON lighter_withdrawal_claim_attempts (withdrawal_intent_id)
  WHERE state IN ('prepared','approved','staged','submitted','confirming','ambiguous');

CREATE INDEX IF NOT EXISTS idx_lighter_withdrawal_claim_session
  ON lighter_withdrawal_claim_attempts (session_id, created_at DESC);
