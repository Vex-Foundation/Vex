-- 101_lighter_rhc_funding_preflight.sql — environment-bound public funding snapshot.
--
-- This JSON is public, non-signing evidence only. It must never contain keys,
-- signatures, signed payloads, auth tokens, or decrypted vault state.

ALTER TABLE lighter_onboarding_intents
  ADD COLUMN IF NOT EXISTS preflight_public_snapshot JSONB;

ALTER TABLE lighter_onboarding_intents
  DROP CONSTRAINT IF EXISTS lighter_onboarding_intents_preflight_values_valid;

ALTER TABLE lighter_onboarding_intents
  ADD CONSTRAINT lighter_onboarding_intents_preflight_values_valid CHECK (
    settlement_token_address IS NULL
    OR (
      settlement_token_decimals = 6
      AND preflight_min_transfer_units > 0
      AND preflight_wallet_balance_units >= 0
      AND preflight_wallet_allowance_units >= 0
      AND preflight_wallet_native_balance_wei > 0
      AND preflight_ethereum_block_number > 0
      AND preflight_lighter_block_number >= 0
      AND (
        (environment = 'core'
         AND chain_id = 1
         AND LOWER(settlement_token_address) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
         AND settlement_token_symbol = 'USDC')
        OR
        (environment = 'rhc'
         AND chain_id = 4663
         AND LOWER(settlement_token_address) = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
         AND settlement_token_symbol = 'USDG')
      )
    )
  );

ALTER TABLE lighter_onboarding_intents
  ADD CONSTRAINT lighter_onboarding_intents_public_snapshot_bound CHECK (
    preflight_public_snapshot IS NULL
    OR (
      jsonb_typeof(preflight_public_snapshot) = 'object'
      AND preflight_public_snapshot ?& ARRAY[
        'observedAt', 'environment', 'lighterRestBaseUrl',
        'settlementNetworkName', 'walletAddress', 'beneficiaryAddress',
        'chainId', 'settlementBlockNumber', 'gatewayAddress',
        'gatewayCodeHash', 'settlementTokenAddress',
        'settlementTokenCodeHash', 'settlementTokenSymbol',
        'settlementTokenDecimals', 'assetIndex', 'routeType', 'amountUnits',
        'depositCalldata', 'depositValueWei'
      ]
      AND preflight_public_snapshot->>'environment' = environment
      AND (preflight_public_snapshot->>'chainId')::INTEGER = chain_id
      AND LOWER(preflight_public_snapshot->>'walletAddress') = LOWER(wallet_address)
      AND LOWER(preflight_public_snapshot->>'beneficiaryAddress') = LOWER(deposit_to)
      AND LOWER(preflight_public_snapshot->>'gatewayAddress') = LOWER(deposit_contract)
      AND LOWER(preflight_public_snapshot->>'settlementTokenAddress') =
          LOWER(settlement_token_address)
      AND (preflight_public_snapshot->>'settlementTokenDecimals')::INTEGER =
          settlement_token_decimals
      AND (preflight_public_snapshot->>'assetIndex')::INTEGER = asset_index
      AND (preflight_public_snapshot->>'routeType')::INTEGER = route_type
      AND preflight_public_snapshot->>'amountUnits' = amount_units::TEXT
      AND preflight_public_snapshot->>'depositValueWei' = '0'
      AND preflight_public_snapshot->>'depositCalldata' ~ '^0x[0-9a-fA-F]+$'
    )
  );

COMMENT ON COLUMN lighter_onboarding_intents.preflight_public_snapshot IS
  'Complete public, environment-bound Lighter deposit preparation snapshot; contains no secret or signed material.';
