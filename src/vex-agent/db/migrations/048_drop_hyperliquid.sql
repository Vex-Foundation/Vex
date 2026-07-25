-- 048: drop Hyperliquid-only tables (Agent Scan Phase 3 — total HL removal).
-- protocol_executions.execution_status (039) is GENERAL infrastructure now
-- consumed by the approval runtime, agent_activity, and every protocol's
-- audit trail — it is NOT dropped here.

DROP INDEX IF EXISTS idx_hyperliquid_candle_watches_enabled;
DROP TABLE IF EXISTS hyperliquid_candle_watches;

DROP INDEX IF EXISTS idx_hyperliquid_candles_pair_newest;
DROP TABLE IF EXISTS hyperliquid_candles;

DROP INDEX IF EXISTS idx_hyperliquid_session_policies_one_active;
DROP INDEX IF EXISTS idx_hyperliquid_session_policies_session_wallet;
DROP TABLE IF EXISTS hyperliquid_session_policies;

-- ── Hyperliquid sync retirement (044's Polymarket pattern) ──────────────────
--
-- Deleting the seed definitions only fixes FRESH databases. An
-- already-installed database still carries the two enabled reconcile jobs
-- from `seedSyncJobs()` (`_global/hyperliquid_reconcile` periodic-60s and
-- `hyperliquid/hyperliquid_reconcile` post-mutation) — a live `syncTick`
-- would keep encountering the periodic one as unknown work forever. Disable
-- both and terminalize ONLY their still-pending/running runs; completed run
-- history stays as audit record (same doctrine as the shared-table rows).

UPDATE protocol_sync_jobs
  SET enabled = false
  WHERE sync_type = 'hyperliquid_reconcile';

UPDATE protocol_sync_runs
  SET status = 'failed',
      ended_at = NOW(),
      error = 'retired: hyperliquid removed'
  WHERE status IN ('pending', 'running')
    AND sync_job_id IN (
      SELECT id FROM protocol_sync_jobs
      WHERE sync_type = 'hyperliquid_reconcile'
    );
