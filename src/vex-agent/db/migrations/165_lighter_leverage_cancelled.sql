-- A leverage proposal the person dismisses has its own honest terminal state.
-- Cancellation is permitted only before Confirm records consent or reserves a
-- nonce; the repository transition is a proposed-only compare-and-set.

ALTER TABLE lighter_leverage_intents
  DROP CONSTRAINT IF EXISTS lighter_leverage_intents_execution_state_check,
  DROP CONSTRAINT IF EXISTS lighter_leverage_intents_check,
  DROP CONSTRAINT IF EXISTS lighter_leverage_intents_check1,
  DROP CONSTRAINT IF EXISTS lighter_leverage_intents_check2,
  DROP CONSTRAINT IF EXISTS lighter_leverage_intents_check3,
  DROP CONSTRAINT IF EXISTS lighter_leverage_intents_check4;

ALTER TABLE lighter_leverage_intents
  ADD CONSTRAINT lighter_leverage_intents_execution_state_check CHECK (
    execution_state IN (
      'proposed', 'expired', 'cancelled', 'refused_unsubmitted', 'signing',
      'signed', 'submission_staged', 'submitted', 'completed', 'ambiguous',
      'rejected', 'expired_unsubmitted'
    )
  ),
  ADD CONSTRAINT lighter_leverage_intents_consent_shape CHECK (
    (execution_state IN ('proposed', 'expired', 'cancelled')) = (consented_at IS NULL)
  ),
  ADD CONSTRAINT lighter_leverage_intents_nonce_shape CHECK (
    execution_state IN ('proposed', 'expired', 'cancelled', 'refused_unsubmitted')
    OR (nonce_value IS NOT NULL AND tx_expiry_ms IS NOT NULL)
  ),
  ADD CONSTRAINT lighter_leverage_intents_hash_shape CHECK (
    execution_state IN ('proposed', 'expired', 'cancelled', 'refused_unsubmitted', 'signing')
    OR signer_tx_hash IS NOT NULL
  ),
  ADD CONSTRAINT lighter_leverage_intents_pre_signing_shape CHECK (
    execution_state NOT IN ('proposed', 'expired', 'cancelled', 'refused_unsubmitted')
    OR (signer_tx_hash IS NULL AND send_attempt_started_at IS NULL)
  ),
  ADD CONSTRAINT lighter_leverage_intents_expired_unsubmitted_shape CHECK (
    execution_state <> 'expired_unsubmitted' OR send_attempt_started_at IS NULL
  );

DROP INDEX IF EXISTS lighter_leverage_one_live_market;

CREATE UNIQUE INDEX lighter_leverage_one_live_market
  ON lighter_leverage_intents(environment, account_index, market_index)
  WHERE execution_state NOT IN (
    'expired', 'cancelled', 'refused_unsubmitted', 'completed', 'rejected',
    'expired_unsubmitted'
  );
