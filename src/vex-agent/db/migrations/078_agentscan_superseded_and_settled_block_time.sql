-- 078: AgentScan full coverage - the outbox admits `superseded_unproven`, and
-- `agent_activity` gains the settled block time.
--
-- PART 1 - agentscan_outbox.status CHECK gains 'superseded_unproven'.
--
-- Migration 073 wrote a three-status CHECK because the ingest contract of the
-- day had three terminal statuses. It now has four: the server's
-- `TERMINAL_STATUSES` accepts `superseded_unproven` as a full terminal state
-- (vex-agentscan packages/contract enums). Until this widening, a row this
-- install had closed as superseded was filtered out of the outbox entirely,
-- leaving the server holding a `pending` row forever.
--
-- SAFETY: strict superset widening. Every existing row stays valid, no
-- backfill is needed, and old application code never writes the new value.
--
-- PART 2 - agent_activity.settled_block_time TIMESTAMPTZ NULL.
--
-- The BLOCK time of the transaction that settled this row, as read from the
-- chain, as distinct from `confirmed_at`, which is the time WE OBSERVED the
-- settlement (`NOW()` at every confirm site). The two differ by however long
-- the app was not running: a sweep that confirms after a restart stamps
-- `confirmed_at` hours after the block.
--
-- It exists because AgentScan cross-checks a reported confirmation time
-- against the block time it reads itself and strikes the install when they
-- differ by more than its tolerance. Reporting the block time (or nothing at
-- all) instead of our observation time removes that class of false strike.
-- This is an ACCURACY improvement on the report, not a safety condition: NULL
-- is the normal state on every historical row and on every confirm site that
-- has no block time to give, and the reporter simply sends no confirmation
-- time for such a row.
--
-- Populated only by writers that genuinely read the block (the EVM repair
-- sweep, from the receipt's block). Never derived from `confirmed_at`, which
-- would re-invent the very number this column exists to avoid. Nullable and
-- write-once by convention: no writer overwrites a non-null value.
--
-- Mirrored into vex-app by: node vex-app/scripts/copy-migrations.mjs

ALTER TABLE agentscan_outbox DROP CONSTRAINT IF EXISTS agentscan_outbox_status_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agentscan_outbox_status_valid'
  ) THEN
    ALTER TABLE agentscan_outbox
      ADD CONSTRAINT agentscan_outbox_status_valid
      CHECK (status IN ('pending', 'confirmed', 'definitively_failed', 'superseded_unproven'));
  END IF;
END$$;

ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS settled_block_time TIMESTAMPTZ;

COMMENT ON COLUMN agent_activity.settled_block_time IS
  'Chain block time of the settling transaction (never NOW()). NULL when no writer could read it; the AgentScan reporter then sends no confirmation time at all.';
