-- 083_lighter_order_provider_outcomes.sql — durable Lighter provider outcome repair.
--
-- Purpose: record bounded, non-secret evidence from authenticated account-data
-- reads after a signed order is accepted by sendTx. API acceptance is not a
-- terminal trading outcome; these fields let Vex resume/reconcile by
-- client_order_id without storing signed payloads, private keys, auth tokens,
-- or raw provider error bodies.

ALTER TABLE lighter_order_execution_intents
  ADD COLUMN IF NOT EXISTS client_order_index TEXT,
  ADD COLUMN IF NOT EXISTS provider_order_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_order_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_outcome_source TEXT,
  ADD COLUMN IF NOT EXISTS provider_outcome_json JSONB,
  ADD COLUMN IF NOT EXISTS provider_outcome_checked_at TIMESTAMPTZ;

ALTER TABLE lighter_order_execution_intents
  ADD CONSTRAINT lighter_order_execution_intents_provider_outcome_shape
  CHECK (
    (client_order_index IS NULL OR client_order_index ~ '^[0-9]+$')
    AND (provider_order_id IS NULL OR (length(provider_order_id) BETWEEN 1 AND 160 AND provider_order_id !~ '[[:space:]{}"]'))
    AND (provider_order_status IS NULL OR (length(provider_order_status) <= 80 AND provider_order_status !~ '[{}"]'))
    AND (
      provider_outcome_source IS NULL
      OR provider_outcome_source IN ('active_order','inactive_order','account_trade','not_found')
    )
    AND (provider_outcome_json IS NULL OR jsonb_typeof(provider_outcome_json) = 'object')
    AND (
      provider_outcome_checked_at IS NULL
      OR execution_state IN ('sequencer_pending','open','partially_filled','filled','canceled','rejected','ambiguous')
    )
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_client_order
  ON lighter_order_execution_intents (environment, account_index, client_order_index)
  WHERE client_order_index IS NOT NULL;
