-- 106_lighter_rhc_withdrawal_claims.sql — independently scoped RHC USDG claims.
--
-- The complete environment identity is one pairwise invariant. A claim cannot
-- cross Core/RHC operation, settlement, gateway, implementation, or token data.

ALTER TABLE lighter_withdrawal_claim_attempts
  DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_operation_class_check,
  DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_settlement_chain_id_check,
  DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_settlement_network_name_check,
  DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_asset_symbol_check;

ALTER TABLE lighter_withdrawal_claim_attempts
  ADD CONSTRAINT lighter_withdrawal_claim_attempts_operation_class_check
    CHECK (operation_class IN ('manual_core_usdc_claim','manual_rhc_usdg_claim')),
  ADD CONSTRAINT lighter_withdrawal_claim_attempts_settlement_chain_id_check
    CHECK (settlement_chain_id IN (1,4663)),
  ADD CONSTRAINT lighter_withdrawal_claim_attempts_settlement_network_name_check
    CHECK (settlement_network_name IN ('Ethereum mainnet','Robinhood Chain mainnet')),
  ADD CONSTRAINT lighter_withdrawal_claim_attempts_asset_symbol_check
    CHECK (asset_symbol IN ('USDC','USDG')),
  ADD CONSTRAINT lighter_withdrawal_claim_attempts_environment_identity_check CHECK (
    (
      operation_class = 'manual_core_usdc_claim'
      AND settlement_chain_id = 1
      AND settlement_network_name = 'Ethereum mainnet'
      AND asset_symbol = 'USDC'
      AND LOWER(settlement_token_address) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      AND LOWER(gateway_address) = '0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7'
      AND LOWER(gateway_implementation) = '0x8d692294a4824d868e35b3cecd734acf41b2342e'
    ) OR (
      operation_class = 'manual_rhc_usdg_claim'
      AND settlement_chain_id = 4663
      AND settlement_network_name = 'Robinhood Chain mainnet'
      AND asset_symbol = 'USDG'
      AND LOWER(settlement_token_address) = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
      AND LOWER(gateway_address) = '0x94bab9693ba2f6358507effcbd372b0660afff9d'
      AND LOWER(gateway_implementation) = '0xe470e41cacc197ea07f879577765a8c81234ed7b'
    )
  );
