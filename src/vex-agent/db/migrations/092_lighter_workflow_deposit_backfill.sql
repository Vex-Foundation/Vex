-- 092_lighter_workflow_deposit_backfill.sql — align upgraded active deposits.
--
-- Migration 091 creates workflows from enabled settings. This follow-up maps
-- any deposit intent that already existed before 091 to the corresponding
-- wallet-level workflow state so the first post-upgrade CAS cannot regress or
-- guess. Only public structural fields are copied.

WITH latest_deposit AS (
  SELECT DISTINCT ON (environment, LOWER(wallet_address))
         environment,
         LOWER(wallet_address) AS wallet_address,
         intent_id,
         execution_state,
         approval_status,
         approve_tx_hash,
         deposit_tx_hash,
         resolved_account_index
    FROM lighter_onboarding_intents
   WHERE capability = 'deposit'
   ORDER BY environment, LOWER(wallet_address), updated_at DESC
)
UPDATE lighter_onboarding_workflows AS workflow
   SET workflow_state = CASE
         WHEN deposit.execution_state = 'credited' THEN 'account_resolved'
         WHEN deposit.execution_state = 'deposit_confirmed' THEN 'deposit_l2_pending'
         WHEN deposit.execution_state = 'deposit_submitted' THEN 'deposit_staged'
         WHEN deposit.execution_state = 'approve_confirmed' THEN 'approve_confirmed'
         WHEN deposit.execution_state = 'approve_submitted' THEN 'approve_staged'
         WHEN deposit.execution_state = 'allowance_verified' THEN 'allowance_verified'
         WHEN deposit.execution_state = 'ambiguous' THEN 'ambiguous'
         WHEN deposit.execution_state = 'failed'
           OR deposit.approval_status IN ('rejected', 'expired') THEN 'failed'
         ELSE 'deposit_approval_pending'
       END,
       last_stable_state = CASE
         WHEN deposit.execution_state = 'ambiguous' AND deposit.deposit_tx_hash IS NOT NULL
           THEN 'deposit_staged'
         WHEN deposit.execution_state = 'ambiguous' AND deposit.approve_tx_hash IS NOT NULL
           THEN 'approve_staged'
         WHEN deposit.execution_state = 'ambiguous' THEN 'deposit_approval_pending'
         WHEN deposit.execution_state = 'credited' THEN 'account_resolved'
         WHEN deposit.execution_state = 'deposit_confirmed' THEN 'deposit_l2_pending'
         WHEN deposit.execution_state = 'deposit_submitted' THEN 'deposit_staged'
         WHEN deposit.execution_state = 'approve_confirmed' THEN 'approve_confirmed'
         WHEN deposit.execution_state = 'approve_submitted' THEN 'approve_staged'
         WHEN deposit.execution_state = 'allowance_verified' THEN 'allowance_verified'
         WHEN deposit.execution_state = 'failed'
           OR deposit.approval_status IN ('rejected', 'expired') THEN 'failed'
         ELSE 'deposit_approval_pending'
       END,
       active_deposit_intent_id = deposit.intent_id,
       resolved_account_index = deposit.resolved_account_index,
       failure_code = CASE
         WHEN deposit.execution_state = 'ambiguous' THEN 'deposit_outcome_ambiguous'
         WHEN deposit.execution_state = 'failed' THEN 'deposit_failed'
         WHEN deposit.approval_status = 'rejected' THEN 'deposit_approval_rejected'
         WHEN deposit.approval_status = 'expired' THEN 'deposit_approval_expired'
         ELSE NULL
       END,
       revision = revision + 1,
       updated_at = NOW()
  FROM latest_deposit AS deposit
 WHERE workflow.environment = deposit.environment
   AND workflow.wallet_address = deposit.wallet_address;
