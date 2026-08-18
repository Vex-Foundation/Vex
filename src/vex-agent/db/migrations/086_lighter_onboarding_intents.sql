-- 086_lighter_onboarding_intents.sql — Lighter wallet-funded onboarding intents.
--
-- Purpose: persist the durable, approval-gated intent for each fund-moving
-- onboarding leg (Phase 7) between preparation and its gated executor. The first
-- leg is the L1 USDC deposit that creates + funds a Vex-wallet-owned Lighter
-- account; the schema is capability-tagged so later legs (key registration,
-- swap, withdrawal) extend it without a new table.
--
-- Production boundary:
--   - Stores addresses, amounts, tx hashes, and lifecycle only. It must NEVER
--     store private keys, seed material, signatures, signed transaction JSON,
--     or raw provider auth errors.
--   - A row authorizes nothing by itself. Signing/broadcast still require a
--     recorded user approval and the privileged execution boundary.
--   - Every lookup is session-scoped and environment-scoped so intents cannot
--     replay across sessions or Core/RHC.

CREATE TABLE IF NOT EXISTS lighter_onboarding_intents (
  intent_id                TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  protocol_execution_id    BIGINT REFERENCES protocol_executions(id) ON DELETE RESTRICT,
  approval_id              TEXT UNIQUE REFERENCES approval_queue(id) ON DELETE SET NULL,
  environment              TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  capability               TEXT NOT NULL CHECK (
    capability IN ('deposit','key_registration','swap','withdrawal')
  ),
  wallet_address           TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  chain_id                 INTEGER NOT NULL CHECK (chain_id > 0),

  -- Deposit-leg fields (required when capability = 'deposit', else NULL).
  deposit_contract         TEXT CHECK (deposit_contract IS NULL OR deposit_contract ~ '^0x[0-9a-fA-F]{40}$'),
  deposit_to               TEXT CHECK (deposit_to IS NULL OR deposit_to ~ '^0x[0-9a-fA-F]{40}$'),
  asset_index              INTEGER CHECK (asset_index IS NULL OR (asset_index >= 1 AND asset_index <= 62)),
  route_type               INTEGER CHECK (route_type IS NULL OR route_type IN (0, 1)),
  amount_units             TEXT CHECK (amount_units IS NULL OR amount_units ~ '^[1-9][0-9]*$'),

  approval_status          TEXT NOT NULL DEFAULT 'approval_pending' CHECK (
    approval_status IN ('approval_pending','approved','rejected','expired')
  ),
  execution_state          TEXT NOT NULL DEFAULT 'prepared' CHECK (
    execution_state IN (
      'prepared',
      'approval_pending',
      'approved',
      'approve_submitted',
      'approve_confirmed',
      'deposit_submitted',
      'deposit_confirmed',
      'credited',
      'ambiguous',
      'failed'
    )
  ),

  -- Persisted before broadcast (staged-broadcast doctrine); never a payload.
  approve_tx_hash          TEXT CHECK (approve_tx_hash IS NULL OR approve_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  deposit_tx_hash          TEXT CHECK (deposit_tx_hash IS NULL OR deposit_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  resolved_account_index   BIGINT CHECK (resolved_account_index IS NULL OR resolved_account_index >= 0),

  decision_reason          TEXT,
  failure_reason           TEXT,
  decided_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL,

  CHECK (
    (approval_status = 'approval_pending' AND decided_at IS NULL)
    OR (approval_status <> 'approval_pending' AND decided_at IS NOT NULL)
  ),
  CHECK (
    capability <> 'deposit'
    OR (deposit_contract IS NOT NULL AND deposit_to IS NOT NULL
        AND asset_index IS NOT NULL AND route_type IS NOT NULL AND amount_units IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_lighter_onboarding_intents_session
  ON lighter_onboarding_intents (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lighter_onboarding_intents_approval
  ON lighter_onboarding_intents (approval_id)
  WHERE approval_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lighter_onboarding_intents_execution
  ON lighter_onboarding_intents (execution_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_lighter_onboarding_intents_wallet
  ON lighter_onboarding_intents (environment, wallet_address, capability, created_at DESC);
