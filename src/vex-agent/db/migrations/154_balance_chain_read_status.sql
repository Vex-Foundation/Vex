-- Additive read health, independent of holdings so an unreadable empty wallet
-- is visible too. No backfill can infer whether an old read succeeded.
-- Older binaries ignore this table; rollback needs no data deletion.
CREATE TABLE IF NOT EXISTS proj_balance_chain_read_status (
  wallet_address TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  stale_since TIMESTAMPTZ,
  failure_reason TEXT,
  read_status TEXT NOT NULL DEFAULT 'ok'
    CONSTRAINT balance_chain_read_status_kind CHECK (read_status IN ('ok', 'read_failed', 'inventory_incomplete')),
  PRIMARY KEY (wallet_address, chain_id),
  CHECK ((failure_reason IS NULL) = (stale_since IS NULL))
);
