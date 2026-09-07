-- 084_lighter_order_pre_submit_revalidation.sql - durable public risk evidence.
--
-- This records only bounded market/account facts checked after approval and
-- before vault access, nonce reservation, signing, or provider submission.

ALTER TABLE lighter_order_execution_intents
  ADD COLUMN IF NOT EXISTS pre_submit_revalidation_json JSONB,
  ADD COLUMN IF NOT EXISTS pre_submit_revalidated_at TIMESTAMPTZ;

ALTER TABLE lighter_order_execution_intents
  ADD CONSTRAINT lighter_order_execution_intents_pre_submit_revalidation_shape
  CHECK (
    (pre_submit_revalidation_json IS NULL) = (pre_submit_revalidated_at IS NULL)
    AND (
      pre_submit_revalidation_json IS NULL
      OR jsonb_typeof(pre_submit_revalidation_json) = 'object'
    )
  ) NOT VALID;
