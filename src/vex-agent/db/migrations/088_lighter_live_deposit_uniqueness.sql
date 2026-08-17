-- 088_lighter_live_deposit_uniqueness.sql — one unresolved deposit per wallet.
--
-- The index is the cross-process authority. Session locks serialize one Vex
-- session, but the same wallet can appear in different sessions or processes;
-- only a database constraint closes that race everywhere.

CREATE UNIQUE INDEX IF NOT EXISTS uq_lighter_onboarding_live_deposit_wallet
  ON lighter_onboarding_intents (environment, LOWER(wallet_address), capability)
  WHERE capability = 'deposit'
    AND approval_status IN ('approval_pending', 'approved')
    AND execution_state NOT IN ('credited', 'failed');
