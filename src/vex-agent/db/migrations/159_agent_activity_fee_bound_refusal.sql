-- Add a local pre-sign fee-bound refusal without changing existing row meanings.
-- Deploy the expanded vocabulary before writers. Rollback must retain this
-- accepted value while any recorded refusal uses it; no backfill is required.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_failure_code_valid;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_failure_code_valid CHECK (failure_code IN (
  'fee_bound_refused', 'route_not_found', 'slippage', 'deadline_expired', 'insufficient_liquidity',
  'allowance_or_balance', 'chain_unsupported', 'simulation_reverted', 'mined_revert',
  'broadcast_error', 'confirmation_timeout', 'unknown', 'bridge_failed', 'bridge_refunded',
  'solana_signature_expired', 'venue_unavailable',
  'archive_gated', 'range_capped', 'rate_limited', 'compute_budget', 'method_unsupported', 'transport'
));
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_fee_refusal_before_sign CHECK (
  failure_code <> 'fee_bound_refused' OR (status = 'definitively_failed' AND tx_hash IS NULL)
);
