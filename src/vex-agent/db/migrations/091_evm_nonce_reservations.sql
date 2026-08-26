-- Durable EVM nonce reservations for locally signed mutations that do not yet
-- own an agent_activity row. Staged Agent Scan paths reserve directly on their
-- existing pending agent_activity row; the allocator reads both sources under
-- one per-(address, chain) advisory transaction lock.

CREATE TABLE IF NOT EXISTS evm_nonce_reservations (
  id                BIGSERIAL PRIMARY KEY,
  chain_id          BIGINT NOT NULL CHECK (chain_id > 0),
  from_address      TEXT NOT NULL,
  nonce             BIGINT NOT NULL CHECK (nonce >= 0),
  purpose           TEXT NOT NULL CHECK (purpose IN ('pendle_allowance')),
  status            TEXT NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'staged', 'accepted', 'terminal', 'abandoned')),
  tx_hash           TEXT,
  last_checked_at   TIMESTAMPTZ,
  verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
  last_verification_reason TEXT CHECK (last_verification_reason IN (
    'in_mempool', 'unknown_to_node', 'rpc_error', 'unreadable_receipt'
  )),
  repair_claim_until TIMESTAMPTZ,
  repair_claim_token UUID,
  terminal_reason   TEXT CHECK (terminal_reason IN (
    'mined_success', 'mined_revert', 'nonce_superseded'
  )),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  terminal_at       TIMESTAMPTZ,

  CONSTRAINT evm_nonce_reservation_hash_state CHECK (
    (status IN ('reserved', 'abandoned') AND tx_hash IS NULL)
    OR (status IN ('staged', 'accepted', 'terminal') AND tx_hash IS NOT NULL)
  ),
  CONSTRAINT evm_nonce_reservation_terminal_time CHECK (
    (status IN ('terminal', 'abandoned')) = (terminal_at IS NOT NULL)
  ),
  CONSTRAINT evm_nonce_reservation_repair_claim_pair CHECK (
    (repair_claim_until IS NULL) = (repair_claim_token IS NULL)
  ),
  CONSTRAINT evm_nonce_reservation_terminal_reason_state CHECK (
    terminal_reason IS NULL OR status = 'terminal'
  )
);

-- Only unresolved reservations participate in allocation. A terminal or
-- provably abandoned pre-broadcast reservation may reuse its number if the
-- node's pending count still calls for it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_evm_nonce_reservations_active_nonce
  ON evm_nonce_reservations (chain_id, lower(from_address), nonce)
  WHERE status IN ('reserved', 'staged', 'accepted');

CREATE INDEX IF NOT EXISTS idx_evm_nonce_reservations_active_wallet
  ON evm_nonce_reservations (chain_id, lower(from_address), nonce DESC)
  WHERE status IN ('reserved', 'staged', 'accepted');

CREATE INDEX IF NOT EXISTS idx_evm_nonce_reservations_repair_due
  ON evm_nonce_reservations (COALESCE(last_checked_at, updated_at), id)
  WHERE status IN ('staged', 'accepted') AND tx_hash IS NOT NULL;
