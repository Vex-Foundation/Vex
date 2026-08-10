-- 076: agent_activity.failure_code gains 'venue_unavailable'.
--
-- WHY: a KyberSwap failure where the venue ANSWERED BUT COULD NOT SERVE US AT
-- ALL was recorded as 'unknown', which is also the bucket for genuinely
-- unmodeled errors. That hid a live incident from telemetry: on 2026-08-10 a
-- user in Vietnam was answered HTTP 403 by KyberSwap's edge on every
-- aggregator quote call and was stranded with no swap venue, and nothing in
-- the activity feed distinguished it from an ordinary unknown failure.
--
-- The class covers: edge refusal (401/403/451), endpoint missing (404), rate
-- limit (429), server error (5xx), timeout, and transport-unreachable (no HTTP
-- response at all). It is deliberately NOT 'route_not_found': that is a
-- semantic verdict the venue rendered about the trade, this is the absence of
-- any verdict at all.
--
-- SAFETY: strict superset widening of the CHECK. Every existing row stays
-- valid and no backfill is needed; old application code never writes the new
-- value, so old-code/new-schema is safe.
--
-- Mirrored into vex-app by: node vex-app/scripts/copy-migrations.mjs

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_failure_code_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_failure_code_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_failure_code_valid
      CHECK (failure_code IN (
        'route_not_found', 'slippage', 'deadline_expired',
        'insufficient_liquidity', 'allowance_or_balance',
        'chain_unsupported', 'simulation_reverted', 'mined_revert',
        'broadcast_error', 'confirmation_timeout', 'unknown',
        'bridge_failed', 'bridge_refunded',
        'solana_signature_expired',
        'venue_unavailable'
      ));
  END IF;
END$$;
