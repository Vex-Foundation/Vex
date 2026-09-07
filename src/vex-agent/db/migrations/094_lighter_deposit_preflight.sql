-- 094_lighter_deposit_preflight.sql — persist the exact live preparation read.
--
-- Public read-only evidence only. This snapshot contains addresses, balances,
-- allowance, block heights, and observation time. It must never contain keys,
-- signatures, signed payloads, auth tokens, or decrypted vault state.

ALTER TABLE lighter_onboarding_intents
  ADD COLUMN IF NOT EXISTS settlement_token_address TEXT,
  ADD COLUMN IF NOT EXISTS settlement_token_symbol TEXT,
  ADD COLUMN IF NOT EXISTS settlement_token_decimals INTEGER,
  ADD COLUMN IF NOT EXISTS preflight_min_transfer_units NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_wallet_balance_units NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_wallet_allowance_units NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_wallet_native_balance_wei NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS preflight_ethereum_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS preflight_lighter_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS preflight_observed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_preflight_complete'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_preflight_complete
      CHECK (
        (settlement_token_address IS NULL
         AND settlement_token_symbol IS NULL
         AND settlement_token_decimals IS NULL
         AND preflight_min_transfer_units IS NULL
         AND preflight_wallet_balance_units IS NULL
         AND preflight_wallet_allowance_units IS NULL
         AND preflight_wallet_native_balance_wei IS NULL
         AND preflight_ethereum_block_number IS NULL
         AND preflight_lighter_block_number IS NULL
         AND preflight_observed_at IS NULL)
        OR
        (settlement_token_address IS NOT NULL
         AND settlement_token_symbol IS NOT NULL
         AND settlement_token_decimals IS NOT NULL
         AND preflight_min_transfer_units IS NOT NULL
         AND preflight_wallet_balance_units IS NOT NULL
         AND preflight_wallet_allowance_units IS NOT NULL
         AND preflight_wallet_native_balance_wei IS NOT NULL
         AND preflight_ethereum_block_number IS NOT NULL
         AND preflight_lighter_block_number IS NOT NULL
         AND preflight_observed_at IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_preflight_values_valid'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_preflight_values_valid
      CHECK (
        settlement_token_address IS NULL
        OR (
          LOWER(settlement_token_address) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
          AND settlement_token_symbol = 'USDC'
          AND settlement_token_decimals = 6
          AND preflight_min_transfer_units > 0
          AND preflight_wallet_balance_units >= 0
          AND preflight_wallet_allowance_units >= 0
          AND preflight_wallet_native_balance_wei > 0
          AND preflight_ethereum_block_number > 0
          -- Lighter currently reports zero here even while provider health is
          -- true; preserve that public value rather than inventing freshness.
          AND preflight_lighter_block_number >= 0
        )
      );
  END IF;
END$$;

COMMENT ON COLUMN lighter_onboarding_intents.preflight_observed_at IS
  'Observation time for the persisted live Lighter/Ethereum deposit preflight.';
