-- 095_lighter_deposit_fee_preflight.sql — approval-visible EIP-1559 ceilings.
--
-- Public read-only evidence only. These values are derived from the exact
-- approval/deposit calldata and contain no key, signature, or signed payload.

ALTER TABLE lighter_onboarding_intents
  ADD COLUMN IF NOT EXISTS preflight_approve_gas_limit NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_deposit_gas_limit NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_max_fee_per_gas_wei NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_max_priority_fee_per_gas_wei NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_approve_max_fee_wei NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_deposit_max_fee_wei NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_total_max_fee_wei NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_native_reserve_wei NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_required_native_balance_wei NUMERIC(78, 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_fee_preflight_complete'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_fee_preflight_complete
      CHECK (
        (preflight_approve_gas_limit IS NULL
         AND preflight_deposit_gas_limit IS NULL
         AND preflight_max_fee_per_gas_wei IS NULL
         AND preflight_max_priority_fee_per_gas_wei IS NULL
         AND preflight_approve_max_fee_wei IS NULL
         AND preflight_deposit_max_fee_wei IS NULL
         AND preflight_total_max_fee_wei IS NULL
         AND preflight_native_reserve_wei IS NULL
         AND preflight_required_native_balance_wei IS NULL)
        OR
        (preflight_approve_gas_limit IS NOT NULL
         AND preflight_deposit_gas_limit IS NOT NULL
         AND preflight_max_fee_per_gas_wei IS NOT NULL
         AND preflight_max_priority_fee_per_gas_wei IS NOT NULL
         AND preflight_approve_max_fee_wei IS NOT NULL
         AND preflight_deposit_max_fee_wei IS NOT NULL
         AND preflight_total_max_fee_wei IS NOT NULL
         AND preflight_native_reserve_wei IS NOT NULL
         AND preflight_required_native_balance_wei IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_fee_preflight_values_valid'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_fee_preflight_values_valid
      CHECK (
        preflight_approve_gas_limit IS NULL
        OR (
          preflight_approve_gas_limit >= 0
          AND preflight_deposit_gas_limit > 0
          AND preflight_max_fee_per_gas_wei > 0
          AND preflight_max_priority_fee_per_gas_wei >= 0
          AND preflight_max_priority_fee_per_gas_wei <= preflight_max_fee_per_gas_wei
          AND preflight_approve_max_fee_wei =
              preflight_approve_gas_limit * preflight_max_fee_per_gas_wei
          AND preflight_deposit_max_fee_wei =
              preflight_deposit_gas_limit * preflight_max_fee_per_gas_wei
          AND preflight_total_max_fee_wei =
              preflight_approve_max_fee_wei + preflight_deposit_max_fee_wei
          AND preflight_native_reserve_wei =
              GREATEST(preflight_approve_max_fee_wei, preflight_deposit_max_fee_wei)
          AND preflight_required_native_balance_wei =
              preflight_total_max_fee_wei + preflight_native_reserve_wei
          AND preflight_wallet_native_balance_wei >= preflight_required_native_balance_wei
          AND (
            (preflight_wallet_allowance_units < amount_units::NUMERIC
             AND preflight_approve_gas_limit > 0)
            OR
            (preflight_wallet_allowance_units >= amount_units::NUMERIC
             AND preflight_approve_gas_limit = 0)
          )
        )
      );
  END IF;
END$$;

COMMENT ON COLUMN lighter_onboarding_intents.preflight_total_max_fee_wei IS
  'Approval-visible maximum Ethereum fee across the required approve and deposit legs.';

COMMENT ON COLUMN lighter_onboarding_intents.preflight_required_native_balance_wei IS
  'Maximum plan fee plus one largest-leg native safety reserve.';
