-- 089_lighter_evm_execution_leases.sql — cross-process wallet execution lock.
--
-- Session leases cannot serialize the same wallet used by two sessions or two
-- desktop processes. This table leases one (chain, wallet) execution slot to a
-- single Lighter onboarding intent. Leases expire after missed heartbeats so a
-- crashed process cannot block the wallet forever.

CREATE TABLE IF NOT EXISTS lighter_evm_execution_leases (
  chain_id       INTEGER NOT NULL CHECK (chain_id > 0),
  wallet_address TEXT NOT NULL CHECK (
    wallet_address = LOWER(wallet_address)
    AND wallet_address ~ '^0x[0-9a-f]{40}$'
  ),
  owner_id       TEXT NOT NULL CHECK (LENGTH(owner_id) BETWEEN 1 AND 200),
  intent_id      TEXT NOT NULL REFERENCES lighter_onboarding_intents(intent_id) ON DELETE CASCADE,
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chain_id, wallet_address),
  CHECK (expires_at > acquired_at)
);

CREATE INDEX IF NOT EXISTS idx_lighter_evm_execution_leases_expiry
  ON lighter_evm_execution_leases (expires_at);
