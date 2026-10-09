-- Accept the reviewed Core and RHC gateway replacements.
--
-- New application work uses only the current reviewed deployment. Retain
-- previously reviewed implementations here so existing withdrawal and claim
-- records survive this upgrade with their original approval identity intact.

ALTER TABLE lighter_withdrawal_intents
  DROP CONSTRAINT IF EXISTS lighter_withdrawal_intents_environment_identity_check;

ALTER TABLE lighter_withdrawal_intents
  ADD CONSTRAINT lighter_withdrawal_intents_environment_identity_check CHECK (
    (
      environment = 'core'
      AND endpoint = 'https://mainnet.zklighter.elliot.ai'
      AND signing_chain_id = 304
      AND settlement_chain_id = 1
      AND settlement_network_name = 'Ethereum mainnet'
      AND asset_symbol = 'USDC'
      AND LOWER(settlement_token_address) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      AND LOWER(gateway_address) = '0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7'
      AND LOWER(gateway_implementation) IN (
        '0x8d692294a4824d868e35b3cecd734acf41b2342e',
        '0xe16c893252616dd49913969f145e733b96a3e5a7'
      )
    ) OR (
      environment = 'rhc'
      AND endpoint = 'https://api.rh.lighter.xyz'
      AND signing_chain_id = 466324
      AND settlement_chain_id = 4663
      AND settlement_network_name = 'Robinhood Chain mainnet'
      AND asset_symbol = 'USDG'
      AND LOWER(settlement_token_address) = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
      AND LOWER(gateway_address) = '0x94bab9693ba2f6358507effcbd372b0660afff9d'
      AND LOWER(gateway_implementation) IN (
        '0xe470e41cacc197ea07f879577765a8c81234ed7b',
        '0x82de5b1161c93afdfe21ba0d5343f01cd7401d90',
        '0x998ecf039eb110b72f5f6c1ea31c2fa41a458faa'
      )
    )
  );

ALTER TABLE lighter_withdrawal_claim_attempts
  DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_environment_identity_check;

ALTER TABLE lighter_withdrawal_claim_attempts
  ADD CONSTRAINT lighter_withdrawal_claim_attempts_environment_identity_check CHECK (
    (
      operation_class = 'manual_core_usdc_claim'
      AND settlement_chain_id = 1
      AND settlement_network_name = 'Ethereum mainnet'
      AND asset_symbol = 'USDC'
      AND LOWER(settlement_token_address) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      AND LOWER(gateway_address) = '0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7'
      AND LOWER(gateway_implementation) IN (
        '0x8d692294a4824d868e35b3cecd734acf41b2342e',
        '0xe16c893252616dd49913969f145e733b96a3e5a7'
      )
    ) OR (
      operation_class = 'manual_rhc_usdg_claim'
      AND settlement_chain_id = 4663
      AND settlement_network_name = 'Robinhood Chain mainnet'
      AND asset_symbol = 'USDG'
      AND LOWER(settlement_token_address) = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
      AND LOWER(gateway_address) = '0x94bab9693ba2f6358507effcbd372b0660afff9d'
      AND LOWER(gateway_implementation) IN (
        '0xe470e41cacc197ea07f879577765a8c81234ed7b',
        '0x82de5b1161c93afdfe21ba0d5343f01cd7401d90',
        '0x998ecf039eb110b72f5f6c1ea31c2fa41a458faa'
      )
    )
  );
