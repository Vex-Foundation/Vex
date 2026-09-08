-- A refused chain read must not freeze every wallet's history indefinitely.
ALTER TABLE proj_portfolio_snapshots
  ADD COLUMN IF NOT EXISTS partial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unresolved_chain_count integer NOT NULL DEFAULT 0
    CHECK (unresolved_chain_count >= 0);

ALTER TABLE proj_portfolio_snapshot_groups
  ADD COLUMN IF NOT EXISTS partial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unresolved_chain_count integer NOT NULL DEFAULT 0
    CHECK (unresolved_chain_count >= 0);

-- Stable wallet-scope identity preserves the bounded wait across app restarts.
CREATE TABLE IF NOT EXISTS proj_snapshot_read_deferrals (
  wallet_scope_key text PRIMARY KEY,
  consecutive_failure_cycles integer NOT NULL CHECK (consecutive_failure_cycles BETWEEN 0 AND 4),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- Compatibility for development databases that already applied the first 154.
ALTER TABLE proj_balance_chain_read_status
  ADD COLUMN IF NOT EXISTS read_status text NOT NULL DEFAULT 'ok';
UPDATE proj_balance_chain_read_status SET read_status = 'read_failed'
  WHERE failure_reason IS NOT NULL AND read_status = 'ok';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'proj_balance_chain_read_status'::regclass
      AND conname = 'balance_chain_read_status_kind') THEN
    ALTER TABLE proj_balance_chain_read_status ADD CONSTRAINT balance_chain_read_status_kind
      CHECK (read_status IN ('ok', 'read_failed', 'inventory_incomplete'));
  END IF;
END $$;
