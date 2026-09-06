-- THE THIRD AGENTSCAN COVERAGE VERSION, AND THE ONE POPULATION IT OWES A
-- CONTROLLED BACKFILL.
--
-- ── The defect this file exists for ─────────────────────────────────────────
--
-- Migration 107 widened the reportable vocabulary to the launchpad family and
-- stamped `agentscan_reporting_state.vocabulary_version = 2`, walking every
-- existing installation through the one-time backfill that widening owed. The
-- launchpads arc then admitted one MORE role into the eligibility predicate -
-- the historical `pools_fee` launch-fee rows, which are the same fee a `vex_fee`
-- launch row is under the spelling used before 107 unified it - and left the
-- coverage version at 2.
--
-- That is the one shape the version gate cannot absorb, because the gate asks
-- `backfill_vocabulary_version >= version` and the version did not move. A MAIN
-- installation that had already completed the V2 backfill satisfies the gate on
-- the day it upgrades; 107's own walk is guarded by `vocabulary_version < 2` and
-- skips that installation entirely; so the first incremental tick after the
-- upgrade sweeps every historical launch fee into `agentscan_outbox` with
-- `backfill = FALSE` and reports months of history to AgentScan as LIVE
-- ACTIVITY. The server has no way to detect that and this installation has no
-- way to correct it, because a completed outbox row is never re-enqueued and
-- never re-sent. (Codex final review 2026-09-06, lane 7.)
--
-- ── What this migration does, and what it deliberately does not ─────────────
--
-- It walks `vocabulary_version` from 2 to 3 and moves the column DEFAULT, so:
--
--   - `db/repos/agentscan-reporting.ts` admits the `pools_fee` arm only at
--     `vocabulary_version >= 3`, which no installation carries until this file
--     runs;
--   - `sync/agentscan-report.ts` `backfillOwed` sees `backfill_vocabulary_version`
--     (2, or NULL) fall short of the build's 3 and runs the CONTROLLED backfill,
--     which enqueues those rows as `backfill = TRUE` - history, correctly
--     labelled - and stamps the mark at 3;
--   - every installation that has NOT yet completed a backfill is unaffected:
--     its first backfill covers all three vocabularies at once.
--
-- It does NOT clear `backfill_enqueued_at`, and that is a deliberate difference
-- from 107. When 107 was written the coverage stamp did not exist yet, so the
-- timestamp was the only marker available to reset. It exists now, and the
-- version comparison is the exact statement of what is owed, so the timestamp
-- keeps saying truthfully when the last backfill ran instead of being erased to
-- force a re-run. An installation that ran an OLD binary against this schema
-- cannot write the stamp at all, which is what keeps it from satisfying the
-- gate.
--
-- It touches NO outbox row. Re-queuing rows here would be a second source of
-- truth for the eligibility predicate: the enqueue is a diff against
-- `UNIQUE (activity_id, status)`, so the controlled backfill picks up exactly
-- the pairs the outbox has never seen and nothing that was already sent.
--
-- ── Compatibility and rollback ─────────────────────────────────────────────
--
-- Expand-only and idempotent. No table, column, constraint or index changes; the
-- UPDATE is guarded by `vocabulary_version < 3`, so re-running the file is a
-- no-op on an installation it has already walked.
--
-- OLD CODE ON A NEW DATABASE is safe. A build whose
-- `AGENTSCAN_VOCABULARY_VERSION` is 2 running against a database stamped at 3
-- reads `vocabulary_version >= 2` for the launchpad-family arm and goes on
-- reporting it; it has no `pools_fee` arm to gate at all, so the historical rows
-- simply stay unreported until a V3 build runs, which is the safe direction. Its
-- backfill mark can only ever be written at 2, so it cannot satisfy the V3 gate
-- for the next build.
--
-- ROLLBACK is `UPDATE agentscan_reporting_state SET vocabulary_version = 2 WHERE
-- id = 1` plus restoring the DEFAULT to 2; there is no down script in this
-- repository's forward-only runner. A backfill already marked at 3 is harmless
-- under the rollback: the diff scan never re-enqueues a pair the outbox holds.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final; `vex-app/scripts/check-build-artifacts.mjs` is the gate.
--
-- Forward-only; idempotent (one guarded state update and a DEFAULT move).

UPDATE agentscan_reporting_state
   SET vocabulary_version = 3,
       updated_at = NOW()
 WHERE id = 1
   AND vocabulary_version < 3;

-- A singleton this installation has not created yet is born at 3, on a schema
-- that already carries every widened role, and reaches all of them through the
-- ordinary first-registration backfill.
ALTER TABLE agentscan_reporting_state
  ALTER COLUMN vocabulary_version SET DEFAULT 3;
