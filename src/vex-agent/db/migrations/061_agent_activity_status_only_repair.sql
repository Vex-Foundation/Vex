-- NUMBERING: 061 is deliberate, not the next free number by file listing.
-- A previous session left an UNCOMMITTED migration 060
-- (`060_agent_activity_amounts_unknown.sql`, the `executed_amounts_unknown`
-- flag approach) which the owner reverted on 2026-07-30. That file was never
-- committed, but `db/migrate.ts` applies canonical SOURCE migrations (not only
-- the `vex-app` mirror), so a developer/integration database MAY already carry
-- schema_version 60. Re-using 060 would be permanently version-skipped there.
-- 061 is forward-only and valid for BOTH histories.
--
-- STATUS-ONLY PENDING-TRANSACTION REPAIR (owner decree 2026-07-30).
--
-- The repair sweeps stop doing per-protocol settlement verification. They now
-- answer exactly one question per pending row — "did this tx hash succeed or
-- revert on its chain?" — and write the status alone. Executed amounts are
-- explicitly DEFERRED by the owner: a repaired row keeps `executed_*` NULL,
-- and Agent Scan shows the QUOTED amount labelled "estimated" instead of
-- pretending a quote is a settlement.
--
-- That makes `confirmed` + NULL executed legs a LEGITIMATE, reachable state
-- for the first time. The three CHECKs below were written when it was
-- unreachable and now forbid the very rows the sweep must write, so they are
-- dropped. This WIDENS what the table accepts — it can never fail on existing
-- data.
--
-- WHAT STILL ENFORCES THE STRICT PATH. Dropping a DB CHECK does not make the
-- happy path sloppy: `confirmActivityEvent`
-- (`db/repos/agent-activity/swap-lifecycle.ts`) keeps its repo-level guards for
-- `swap` and every `yield_*` role and GAINS one for `wrap`/`unwrap` (which had
-- no repo-level guard, only the 051 CHECK dropped here). The one deliberate
-- bypass is `confirmActivityEventStatusOnly`, the sweep-owned finalizer that
-- writes no amount columns at all.
--
-- KEPT (unchanged): `agent_activity_confirmed_has_hash`,
-- `agent_activity_failed_has_code`,
-- `agent_activity_pending_has_no_terminal_fields`.

-- Reverted 060's flag column, if this database ever applied it. CASCADE also
-- removes any CHECK constraint that referenced the column — that migration was
-- untracked, so its constraint names are not recoverable and cannot be dropped
-- by name. A no-op on a clean install.
ALTER TABLE agent_activity DROP COLUMN IF EXISTS executed_amounts_unknown CASCADE;

ALTER TABLE agent_activity
  DROP CONSTRAINT IF EXISTS agent_activity_confirmed_swap_has_executed_legs;
ALTER TABLE agent_activity
  DROP CONSTRAINT IF EXISTS agent_activity_confirmed_wrap_has_executed_legs;
ALTER TABLE agent_activity
  DROP CONSTRAINT IF EXISTS agent_activity_yield_confirmed_legs;

-- Cadence: the sweeps are now cheap status polls (one receipt / signature-status
-- read per pending row), so they run every 30s instead of 120s/60s. `seed.ts`
-- inserts `ON CONFLICT DO NOTHING`, so an EXISTING install keeps its old
-- interval unless this UPDATE moves it. The bridge sweep is deliberately NOT
-- included: it polls a provider ORDER-STATUS API, not a chain RPC.
UPDATE protocol_sync_jobs
   SET interval_seconds = 30
 WHERE namespace = '_global'
   AND sync_type IN ('agent_activity_repair', 'solana_activity_repair');
