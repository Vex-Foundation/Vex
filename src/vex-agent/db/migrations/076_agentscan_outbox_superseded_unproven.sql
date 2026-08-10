-- 076 — AgentScan outbox: admit `superseded_unproven` as a reportable status.
--
-- 073 bounded `agentscan_outbox.status` to the three statuses the ingest
-- contract accepted at the time. AgentScan now accepts a FOURTH:
-- `superseded_unproven` — a TERMINAL, NON-FAILURE state (migration 068,
-- owner decision A6) asserting only that the hash is no longer tracked as in
-- flight and that its outcome is unproven.
--
-- Reporting it is what stops the explorer from showing a row as forever
-- `pending` when this install has already stopped waiting on it. It carries no
-- `failure_code` and no surface may render it as a failure — the mapper emits
-- no `failureCode` for it, because it is neither `confirmed` nor
-- `definitively_failed`.
--
-- The outbox status vocabulary is now the WHOLE `agent_activity` status
-- vocabulary (068's four), so this is the last widening this CHECK can need.
--
-- ROLLOUT ORDER. This migration only lets the outbox HOLD the status; the
-- server must already accept it before rows carrying it are sent. AgentScan's
-- widened contract ships first — see `REPORTED_STATUSES` in
-- `db/repos/agentscan-reporting.ts`.
--
-- The CHECK is REPLACED, not added to: a constraint cannot be widened in
-- place. 073 declared it as an inline COLUMN check, so Postgres assigned its
-- name. Dropping a GUESSED name would be a silent no-op on any database where
-- the name differs, and the old constraint would then still reject every
-- `superseded_unproven` write — so the drop finds the constraint by its
-- DEFINITION, exactly as 072 and 075 do.
--
-- The search predicate matches the three ORIGINAL values only (never the new
-- one), exactly as 075's does — so a second run of this migration finds the
-- same constraint again (its widened definition still contains all three) and
-- repeats an identical drop-and-recreate, rather than finding nothing and
-- failing on a duplicate-name ADD CONSTRAINT.

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'agentscan_outbox'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%pending%'
       AND pg_get_constraintdef(con.oid) LIKE '%confirmed%'
       AND pg_get_constraintdef(con.oid) LIKE '%definitively_failed%'
  LOOP
    EXECUTE format('ALTER TABLE agentscan_outbox DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE agentscan_outbox
  ADD CONSTRAINT agentscan_outbox_status_check
  CHECK (status IN ('pending', 'confirmed', 'definitively_failed', 'superseded_unproven'));

COMMENT ON COLUMN agentscan_outbox.status IS
  'Status SNAPSHOT at enqueue time — the full agent_activity vocabulary, including the terminal non-failure superseded_unproven.';
