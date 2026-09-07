-- 103_lighter_withdrawal_lifecycle.sql — monotonic Core withdrawal timestamps.

ALTER TABLE lighter_withdrawal_intents
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submission_staged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS api_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS l2_executed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimable_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS destination_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settlement_scan_from_block TEXT
    CHECK (settlement_scan_from_block IS NULL OR settlement_scan_from_block ~ '^[0-9]+$'),
  ADD COLUMN IF NOT EXISTS withdrawal_history_timestamp BIGINT
    CHECK (withdrawal_history_timestamp IS NULL OR withdrawal_history_timestamp >= 0);

CREATE INDEX IF NOT EXISTS idx_lighter_withdrawal_last_checked
  ON lighter_withdrawal_intents (COALESCE(last_checked_at, updated_at) ASC)
  WHERE execution_state NOT IN ('destination_confirmed','rejected','failed','refunded','expired');
