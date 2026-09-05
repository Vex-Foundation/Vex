-- 102_portfolio_snapshot_group_wallets.sql - in-flight money is attributed PER
-- WALLET, and the group's totals stop being a group-wide figure a subset read
-- can inherit.
--
-- THE DEFECT THIS CLOSES (external review, 2026-09-04). Migration 101 records
-- ONE in-transit total and ONE ledger for the whole inventory the sync cycle
-- scanned. `vex-app/src/main/database/portfolio-db.ts` then attaches that whole
-- figure to whatever address SUBSET the reader asked about. So: wallet B has a
-- pending bridge, the user opens a project or session scoped to wallet A only,
-- and B's in-transit amount is added to A's portfolio. The money is real, the
-- attribution is not, and the number the user reads is a wallet's balance plus
-- a stranger's bridge.
--
-- The reference is MetaMask's `bridge-status-controller`
-- (`agents-colab/metamask-core/packages/bridge-status-controller`): its history
-- item is written with `account: selectedAddress` at creation
-- (`utils/history.ts` `getInitialHistoryItem`) and every scoped operation
-- filters on `bridgeHistoryItem.account === address`, so one account's pending
-- item can never be counted into another's. This table is that same idea in
-- durable form.
--
-- WHY A CHILD TABLE AND NOT JSONB ON THE GROUP ROW. The reader's question is
-- "sum the in-flight components of THESE wallets", which is a keyed aggregate.
-- A child table answers it with `SUM(...) WHERE wallet_address = ANY($1)`,
-- carries a CHECK on every component of every wallet, gets referential
-- integrity from a real foreign key, and stays readable in psql during an
-- incident. Per-wallet JSONB on the group row would need path extraction per
-- key in every reader, could not be constrained per element, and would make the
-- money columns invisible to the constraint system - on a money path that is
-- the wrong trade for saving one table.
--
-- COLUMNS.
--   snapshot_group_id  the group, cascading from `proj_portfolio_snapshot_groups`.
--   wallet_address     the raw stored address, exactly as `proj_balances` and
--                      `proj_portfolio_snapshots` hold it. NEVER lowercased:
--                      the engine stores checksum/base58 forms and every join
--                      in this schema is on the raw string.
--   entry_count        every in-flight row this wallet had at publication,
--                      whether or not it fitted the group's bounded ledger.
--   unresolved_count   those whose kind's bound had passed. In NO total.
--   in_transit_usd     sum of the USD ESTIMATES of this wallet's `in_transit`
--                      rows. An estimate, never a settlement figure.
--
-- A WALLET WITH NOTHING IN FLIGHT HAS NO ROW. Absent means zero, which is also
-- what a group written before this migration reports, so the reader needs no
-- version branch and no backfill exists to write: pre-102 groups carry no
-- attribution at all (their ledger entries predate the `walletAddress` field),
-- and inventing one would be fabricating money-path data. They read as in
-- transit 0 / unresolved 0, exactly as migration 101 already specified for
-- groups written before IT. Snapshot groups are published every sync cycle, so
-- the two most recent groups - the only ones the PnL basis reads - carry
-- attribution within one cycle of this migration applying.
--
-- ALSO IN THIS MIGRATION, on `proj_portfolio_snapshot_groups`:
--
--   in_flight_total_count  the number of in-flight rows the ledger FOUND. The
--                          `in_flight` array is bounded at 50 entries; this is
--                          not. A reader compares the two to know whether it
--                          holds the whole list. Without it the bound silently
--                          removes rows from a report that claims to be
--                          complete, which the repository's no-silent-cutting
--                          decree forbids. DEFAULT 0 so existing rows stay
--                          readable: a pre-102 group reports 0 found, which
--                          beside its stored array reads as "not truncated" -
--                          the same answer that group has always given.
--
--   the non-negative CHECK on in_transit_usd. A negative in-transit total is
--   not a liability, it is a bad price estimate, and the reader would render it
--   as a SUBTRACTION from the user's portfolio. The writer now maps a negative
--   estimate to "not priced" (`sync/balance-sync/publication-gate.ts`), and
--   this constraint is the durable floor under that decision.
--
--   REPAIR before the constraint: any existing row with a negative
--   `in_transit_usd` is set to 0. It is idempotent, bounded to one column of
--   one table, and it corrects a value that was never meaningful; without it a
--   single such row would abort this migration and block application boot.
--   `settled_usd` - the measured half - is never touched.
--
-- ROLLBACK CONTRACT.
--   DROP TABLE IF EXISTS proj_portfolio_snapshot_group_wallets;
--   ALTER TABLE proj_portfolio_snapshot_groups
--     DROP CONSTRAINT IF EXISTS proj_portfolio_snapshot_groups_in_transit_usd_check,
--     DROP COLUMN IF EXISTS in_flight_total_count;
-- No data repair and no reader/writer ordering requirement: nothing references
-- the child table, the dropped column has a default, and a reader that predates
-- this migration never looked at either. The only loss is per-wallet
-- attribution for groups taken while it existed; every settled row survives
-- untouched. The clamped negative estimates are NOT restorable, which is the
-- accepted cost of the repair above.
--
-- EXPAND-ONLY and readable by old code: nothing existing is altered in meaning
-- or dropped, and `proj_portfolio_snapshot_groups` keeps every column it had.
-- Forward-only and idempotent via IF NOT EXISTS, per the runner's contract
-- (`src/lib/db/migrate-runner.ts` applies every file whose numeric prefix is
-- above `MAX(schema_version.version)`, each inside its own transaction).

CREATE TABLE IF NOT EXISTS proj_portfolio_snapshot_group_wallets (
  snapshot_group_id  UUID    NOT NULL
    REFERENCES proj_portfolio_snapshot_groups(snapshot_group_id) ON DELETE CASCADE,
  wallet_address     TEXT    NOT NULL,
  entry_count        INTEGER NOT NULL,
  unresolved_count   INTEGER NOT NULL,
  in_transit_usd     NUMERIC NOT NULL,
  PRIMARY KEY (snapshot_group_id, wallet_address),
  CONSTRAINT proj_portfolio_snapshot_group_wallets_entry_count_check
    CHECK (entry_count >= 0),
  CONSTRAINT proj_portfolio_snapshot_group_wallets_unresolved_count_check
    CHECK (unresolved_count >= 0),
  -- Per wallet: money in transit is money, and money in transit is
  -- never negative. A wallet's component cannot subtract from a scoped read.
  CONSTRAINT proj_portfolio_snapshot_group_wallets_in_transit_usd_check
    CHECK (in_transit_usd >= 0),
  -- Counted rows cannot exceed the rows that exist.
  CONSTRAINT proj_portfolio_snapshot_group_wallets_unresolved_within_entries
    CHECK (unresolved_count <= entry_count)
);

-- Every scoped read filters wallets first and then aggregates, so the address
-- is the leading predicate and the primary key (group, address) cannot serve
-- it.
CREATE INDEX IF NOT EXISTS proj_portfolio_snapshot_group_wallets_wallet_idx
  ON proj_portfolio_snapshot_group_wallets (wallet_address, snapshot_group_id);

ALTER TABLE proj_portfolio_snapshot_groups
  ADD COLUMN IF NOT EXISTS in_flight_total_count INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'proj_portfolio_snapshot_groups_in_flight_total_count_check'
  ) THEN
    ALTER TABLE proj_portfolio_snapshot_groups
      ADD CONSTRAINT proj_portfolio_snapshot_groups_in_flight_total_count_check
      CHECK (in_flight_total_count >= 0);
  END IF;
END $$;

-- The repair described in the header, before the constraint that would
-- otherwise refuse the row and abort the migration.
UPDATE proj_portfolio_snapshot_groups
   SET in_transit_usd = 0
 WHERE in_transit_usd < 0;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'proj_portfolio_snapshot_groups_in_transit_usd_check'
  ) THEN
    ALTER TABLE proj_portfolio_snapshot_groups
      ADD CONSTRAINT proj_portfolio_snapshot_groups_in_transit_usd_check
      CHECK (in_transit_usd >= 0);
  END IF;
END $$;
