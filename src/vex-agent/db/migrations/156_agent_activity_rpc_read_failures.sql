-- Preserve the existing RPC failure vocabulary for hashless pre-sign refusals.
-- Existing rows retain their meaning. Broadcast ambiguity remains pending.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_failure_code_valid;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_failure_code_valid CHECK (failure_code IN (
  'route_not_found', 'slippage', 'deadline_expired', 'insufficient_liquidity',
  'allowance_or_balance', 'chain_unsupported', 'simulation_reverted', 'mined_revert',
  'broadcast_error', 'confirmation_timeout', 'unknown', 'bridge_failed', 'bridge_refunded',
  'solana_signature_expired', 'venue_unavailable',
  'archive_gated', 'range_capped', 'rate_limited', 'compute_budget', 'method_unsupported', 'transport'
));
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_rpc_failure_before_sign CHECK (
  failure_code NOT IN ('archive_gated', 'range_capped', 'rate_limited', 'compute_budget', 'method_unsupported', 'transport')
  OR (status = 'definitively_failed' AND tx_hash IS NULL)
);
