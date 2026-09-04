-- 101_portfolio_snapshot_groups.sql - a snapshot group states what it MEASURED,
-- what is ON ITS WAY, and what nobody could account for.
--
-- THE REVERSED DECISION. Until now `sync/balance-sync/publication-gate.ts`
-- treated every in-flight money row as a REASON NOT TO PUBLISH, and age only
-- escalated the report, never released it. The failure that reversed it was
-- measured, not theoretical: one `bridge_fill_expected` row whose provider
-- never conclusively reported withheld EVERY portfolio snapshot for 31 days, so
-- the Position card showed a month-old baseline beside a live total. That is a
-- worse lie than either honest number.
--
-- The anxiety case the old design existed to prevent - "I bridged $150 of my
-- $200, a snapshot fires mid-flight and the card shows $50 and a $150 loss" -
-- is still impossible, but it is now prevented by ACCOUNTING for the $150
-- rather than by refusing to write anything. This table is where that
-- accounting lives.
--
-- ONE ROW PER SNAPSHOT GROUP, written in the SAME transaction as that group's
-- `proj_portfolio_snapshots` rows (`sync/balance-sync/snapshot-publication.ts`),
-- under `LOCK TABLE agent_activity IN SHARE MODE`. Whole group or none: a
-- record without its per-wallet rows, or rows without their record, would make
-- the published total unreadable.
--
-- COLUMNS.
--   settled_usd       Sum of the group's per-wallet `total_usd`: balances that
--                     were actually read. Unchanged in meaning from what
--                     `proj_portfolio_snapshots.total_usd` has always been.
--   in_transit_usd    Sum of the USD ESTIMATES of the entries whose standing is
--                     `in_transit`. An estimate, never a settlement figure, and
--                     0 when nothing is in flight or nothing carries a price.
--   unresolved_count  Entries whose kind's bound has passed. They are LISTED in
--                     `in_flight` and counted here and are in NO total, in
--                     either direction: money whose outcome nobody can prove
--                     must not be asserted as present or as lost.
--   in_flight         The ledger itself: a bounded array (at most
--                     `MAX_IN_FLIGHT` = 50 entries, the gate's own bound; an
--                     overflow keeps the OLDEST and is reported in the sync
--                     log, never dropped silently) of
--                     {kind, ref, detail, standing, ageSeconds, amountHuman,
--                      symbol, usdEstimate}. Amounts are STRINGS with their
--                     symbol beside them (rule 90: raw amounts travel with
--                     units, and no token amount touches floating point);
--                     `usdEstimate` is a nullable display numeric.
--
-- NUMERIC, not float8, for both USD columns: this is a durable money record and
-- the reader casts to float8 only at the display boundary, exactly as
-- `proj_portfolio_snapshots.total_usd` is read today.
--
-- NO FOREIGN KEY to `proj_portfolio_snapshots`. That table has no unique key on
-- `snapshot_group_id` - by design, since a group is one row PER WALLET - so
-- there is nothing to reference. The two are bound by being written in one
-- transaction, which is a stronger guarantee than a constraint that cannot be
-- declared.
--
-- EXPAND-ONLY, and readable by old code. Nothing existing is altered, dropped
-- or backfilled: `proj_portfolio_snapshots` keeps every column and every
-- meaning it had, so a build that predates this migration reads groups written
-- after it exactly as before. New readers must treat a MISSING group row as
-- "in transit 0, unresolved 0" - every group written before this migration is
-- that case, and `vex-app/src/main/database/portfolio-db.ts` does so with a
-- LEFT-JOIN-shaped scalar subquery rather than an inner join.
--
-- ROLLBACK CONTRACT. `DROP TABLE IF EXISTS proj_portfolio_snapshot_groups;`
-- with no data repair and no reader/writer ordering requirement: no other table
-- references it, no existing row depends on it, and the pre-migration reader
-- never looked at it. The only loss is the in-flight accounting for groups
-- taken while it existed; the per-wallet settled rows survive untouched.
--
-- Forward-only and idempotent via IF NOT EXISTS, per the runner's contract
-- (`src/lib/db/migrate-runner.ts` applies every file whose numeric prefix is
-- above `MAX(schema_version.version)`, each inside its own transaction).

CREATE TABLE IF NOT EXISTS proj_portfolio_snapshot_groups (
  snapshot_group_id  UUID PRIMARY KEY,
  settled_usd        NUMERIC NOT NULL,
  in_transit_usd     NUMERIC NOT NULL,
  unresolved_count   INTEGER NOT NULL,
  in_flight          JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The ledger is an ARRAY, always. A defensive shape check, not a schema for its
-- entries: the entry contract is owned and validated by
-- `sync/balance-sync/publication-gate.ts` and by the reader's zod schema, and
-- widening it must not require a migration.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'proj_portfolio_snapshot_groups_in_flight_is_array'
  ) THEN
    ALTER TABLE proj_portfolio_snapshot_groups
      ADD CONSTRAINT proj_portfolio_snapshot_groups_in_flight_is_array
      CHECK (jsonb_typeof(in_flight) = 'array');
  END IF;
END $$;

-- Counts are counts. A negative one would be a writer defect reaching durable
-- state, and the reader would render it as a subtraction from the portfolio.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'proj_portfolio_snapshot_groups_unresolved_count_check'
  ) THEN
    ALTER TABLE proj_portfolio_snapshot_groups
      ADD CONSTRAINT proj_portfolio_snapshot_groups_unresolved_count_check
      CHECK (unresolved_count >= 0);
  END IF;
END $$;
