-- Durable pre-sign audit records for Hyperliquid mutations.
--
-- Existing protocol_executions remains the single audit/capture source. A
-- Hyperliquid mutation first inserts an `intent` row, then atomically updates
-- that same row with the known exchange outcome and capture after submission.

ALTER TABLE protocol_executions
  ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'succeeded'
  CHECK (execution_status IN ('intent', 'succeeded', 'failed'));

CREATE INDEX IF NOT EXISTS idx_protocol_executions_status
  ON protocol_executions (execution_status, created_at DESC);
