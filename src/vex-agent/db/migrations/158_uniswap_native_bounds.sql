-- One local settlement evidence source, not a provider-observed bridge row.
ALTER TABLE agent_activity DROP CONSTRAINT agent_activity_non_bridge_no_bridge_cols;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_non_bridge_no_bridge_cols CHECK (
  kind = 'bridge' OR (
    from_chain_id IS NULL AND from_chain_slug IS NULL
    AND to_chain_id IS NULL AND to_chain_slug IS NULL
    AND provider_order_id IS NULL AND normalized_route IS NULL
    AND provider_status IS NULL AND last_attempted_at IS NULL
    AND (evidence_source IS NULL OR evidence_source = 'native_balance_delta_bound')
    AND observed_at IS NULL
  )
);
ALTER TABLE agent_activity DROP CONSTRAINT agent_activity_observed_no_local_fields;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_observed_no_local_fields CHECK (
  evidence_source IS NULL OR evidence_source = 'native_balance_delta_bound'
  OR (from_address IS NULL AND nonce IS NULL AND submit_attempted_at IS NULL AND broadcast_at IS NULL)
);
ALTER TABLE agent_activity DROP CONSTRAINT agent_activity_evm_signed_leg_has_nonce;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_evm_signed_leg_has_nonce CHECK (
  (evidence_source IS NOT NULL AND evidence_source <> 'native_balance_delta_bound')
  OR tx_hash IS NULL OR chain_family <> 'eip155' OR nonce IS NOT NULL
);
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_native_bound_valid CHECK (
  evidence_source IS DISTINCT FROM 'native_balance_delta_bound' OR (
    protocol = 'uniswap' AND kind = 'swap' AND event_role = 'swap' AND chain_family = 'eip155'
    AND route_provenance->'settlementDecode'->>'decoder' = 'uniswap'
    AND jsonb_typeof(route_provenance->'settlementDecode'->'v4') = 'object'
    AND status = 'confirmed' AND tx_hash IS NOT NULL AND nonce IS NOT NULL
    AND token_in_decimals = 18 AND token_in_symbol IS NOT NULL
    AND from_address IS NOT NULL AND lower(from_address) = lower(wallet_address)
    AND (lower(token_in_address) IN ('0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
      OR (token_in_address IS NULL AND token_in_decimals = 18 AND token_in_symbol IS NOT NULL
          AND route_provenance->'settlementDecode'->>'declaredValueRaw' IS NOT NULL))
    AND executed_amount_in_raw IS NOT NULL AND settlement_source = 'native_balance_delta_bound'
  ) IS TRUE
);
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_native_output_unknown_valid CHECK (
  pending_reason IS DISTINCT FROM 'native_output_unproven_hooked' OR (
    protocol = 'uniswap' AND kind = 'swap' AND event_role = 'swap' AND status = 'confirmed'
    AND route_provenance->'settlementDecode'->>'decoder' = 'uniswap'
    AND jsonb_typeof(route_provenance->'settlementDecode'->'v4') = 'object'
    AND chain_family = 'eip155' AND tx_hash IS NOT NULL AND executed_amount_in_raw IS NOT NULL
    AND token_out_decimals = 18 AND token_out_symbol IS NOT NULL
    AND (lower(token_out_address) IN ('0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
      OR (token_out_address IS NULL AND token_out_decimals = 18 AND token_out_symbol IS NOT NULL
          AND route_provenance->'settlementDecode'->>'wrappedNativeAddress' IS NOT NULL))
    AND executed_amount_out_raw IS NULL
  ) IS TRUE
);
COMMENT ON COLUMN agent_activity.evidence_source IS
  'Provider observation provenance, except native_balance_delta_bound: a locally signed Uniswap native input lower bound, not exact spend. Local nonce fields remain required for that source.';
COMMENT ON COLUMN agent_activity.pending_reason IS
  'Pending lifecycle reason, plus native_output_unproven_hooked on a confirmed Uniswap swap whose native output is unknown. This exception does not make mined status pending.';
