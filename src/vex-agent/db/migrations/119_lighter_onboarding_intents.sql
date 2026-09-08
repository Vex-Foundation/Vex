-- Lighter wallet-funded onboarding intents.
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

  -- THE UNATTENDED REPAIR SWEEP'S FAIRNESS TOKEN.
  --
  -- The bounded deposit repair sweep orders its queue by the last ATTEMPT,
  -- never by the last success and never by updated_at alone. A row nothing can
  -- move keeps its updated_at forever, so an updated_at ordering hands the
  -- first page of every sweep to the same rows: with more unresolved rows than
  -- one sweep examines, the rows past the first page are never reached, and a
  -- single row that consumes the whole sweep deadline is examined again by the
  -- next sweep and by every sweep after it.
  --
  -- The marker is written BEFORE the provider read and overwritten with the
  -- settled result after it, so a row that dies mid-repair (a provider hang, a
  -- process kill) has ALREADY moved to the tail of the queue. A row still
  -- carrying 'attempted' is exactly that case, and it is readable as such.
  repair_attempted_at      TIMESTAMPTZ,
  repair_attempt_result    TEXT CHECK (
    repair_attempt_result IN ('attempted','advanced','awaiting','terminal','error')
  ),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL,

  CHECK (
    (approval_status = 'approval_pending' AND decided_at IS NULL)
    OR (approval_status <> 'approval_pending' AND decided_at IS NOT NULL)
  ),
  CHECK (
    (repair_attempted_at IS NULL) = (repair_attempt_result IS NULL)
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

-- The repair sweep's queue index: least recently attempted first, exactly the
-- order the sweep reads in, over exactly the rows it considers. NULLS FIRST is
-- the default for ASC, so a never-attempted row sorts to the front without a
-- separate expression.
CREATE INDEX IF NOT EXISTS idx_lighter_onboarding_intents_deposit_repair_queue
  ON lighter_onboarding_intents (repair_attempted_at ASC, updated_at ASC, intent_id ASC)
  WHERE capability = 'deposit'
    AND execution_state NOT IN ('credited','failed')
    AND approval_status <> 'rejected';

COMMENT ON COLUMN lighter_onboarding_intents.repair_attempted_at IS
  'The deposit repair sweep ORDERS by this, never by success: ordering by success starves rows no evidence can move.';
COMMENT ON COLUMN lighter_onboarding_intents.repair_attempt_result IS
  'What the last attempt produced. Written as attempted before the provider read and settled after it.';
