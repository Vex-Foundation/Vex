-- 082_lighter_order_submit_lifecycle.sql — Lighter order submit lifecycle fields.
--
-- Purpose: persist safe metadata around future signed Lighter order submission.
-- This migration does not make any order path reachable. It gives the approval
-- gated path durable places to record "signed", "submitted", "API accepted",
-- and "ambiguous" without storing key bytes, sig artifacts, signed payload JSON,
-- provider raw auth errors, or submit bodies.

ALTER TABLE lighter_order_execution_intents
  ADD COLUMN IF NOT EXISTS signer_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS submitted_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS submit_code INTEGER,
  ADD COLUMN IF NOT EXISTS submit_message TEXT,
  ADD COLUMN IF NOT EXISTS predicted_execution_time_ms INTEGER,
  ADD COLUMN IF NOT EXISTS volume_quota_remaining BIGINT,
  ADD COLUMN IF NOT EXISTS ambiguous_reason TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS api_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ambiguous_at TIMESTAMPTZ;

ALTER TABLE lighter_order_execution_intents
  DROP CONSTRAINT IF EXISTS lighter_order_execution_intents_api_key_index_check;

ALTER TABLE lighter_order_execution_intents
  ADD CONSTRAINT lighter_order_execution_intents_api_key_index_check
  CHECK (api_key_index >= 4 AND api_key_index <= 254) NOT VALID;

ALTER TABLE lighter_order_execution_intents
  ADD CONSTRAINT lighter_order_execution_intents_submit_lifecycle_shape
  CHECK (
    (signer_tx_hash IS NULL OR (length(signer_tx_hash) BETWEEN 1 AND 160 AND signer_tx_hash !~ '[[:space:]{}"]'))
    AND (submitted_tx_hash IS NULL OR (length(submitted_tx_hash) BETWEEN 1 AND 160 AND submitted_tx_hash !~ '[[:space:]{}"]'))
    AND (submit_code IS NULL OR submit_code >= 0)
    AND (submit_message IS NULL OR (length(submit_message) <= 240 AND submit_message !~ '[{}"]'))
    AND (predicted_execution_time_ms IS NULL OR predicted_execution_time_ms >= 0)
    AND (volume_quota_remaining IS NULL OR volume_quota_remaining >= 0)
    AND (ambiguous_reason IS NULL OR (length(ambiguous_reason) <= 240 AND ambiguous_reason !~ '[{}"]'))
    AND (
      (execution_state = 'signed' AND signed_at IS NOT NULL)
      OR (execution_state = 'submitted' AND signed_at IS NOT NULL AND submitted_at IS NOT NULL)
      OR (execution_state = 'api_accepted' AND signed_at IS NOT NULL AND submitted_at IS NOT NULL AND api_accepted_at IS NOT NULL)
      OR (execution_state = 'ambiguous' AND ambiguous_at IS NOT NULL)
      OR execution_state NOT IN ('signed','submitted','api_accepted','ambiguous')
    )
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_submit_state
  ON lighter_order_execution_intents (execution_state, submitted_at DESC)
  WHERE submitted_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_signer_tx_hash
  ON lighter_order_execution_intents (environment, signer_tx_hash)
  WHERE signer_tx_hash IS NOT NULL;
