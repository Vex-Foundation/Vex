-- Preserve the exact provider message returned after an accepted Lighter
-- order submission. The message is parameterized database evidence and is not
-- used as model guidance, so JSON punctuation must not invalidate acceptance.

ALTER TABLE lighter_order_execution_intents
  DROP CONSTRAINT IF EXISTS lighter_order_execution_intents_submit_lifecycle_shape;

ALTER TABLE lighter_order_execution_intents
  ADD CONSTRAINT lighter_order_execution_intents_submit_lifecycle_shape
  CHECK (
    (signer_tx_hash IS NULL OR (length(signer_tx_hash) BETWEEN 1 AND 160 AND signer_tx_hash !~ '[[:space:]{}"]'))
    AND (submitted_tx_hash IS NULL OR (length(submitted_tx_hash) BETWEEN 1 AND 160 AND submitted_tx_hash !~ '[[:space:]{}"]'))
    AND (submit_code IS NULL OR submit_code >= 0)
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
