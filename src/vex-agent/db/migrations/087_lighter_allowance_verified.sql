-- 087_lighter_allowance_verified.sql — record the no-approval-tx deposit path.
--
-- A sufficient existing USDC allowance is chain evidence, not a confirmed
-- approval transaction. Give that path its own durable state so the deposit
-- executor never fabricates approve_confirmed without an approve_tx_hash.

ALTER TABLE lighter_onboarding_intents
  DROP CONSTRAINT IF EXISTS lighter_onboarding_intents_execution_state_check;

ALTER TABLE lighter_onboarding_intents
  ADD CONSTRAINT lighter_onboarding_intents_execution_state_check CHECK (
    execution_state IN (
      'prepared',
      'approval_pending',
      'approved',
      'allowance_verified',
      'approve_submitted',
      'approve_confirmed',
      'deposit_submitted',
      'deposit_confirmed',
      'credited',
      'ambiguous',
      'failed'
    )
  );
