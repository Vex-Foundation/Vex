-- 098: the WALLET-ADDRESS access path for the three intent tables the snapshot
-- publication gate reads.
--
-- THE MEASURED PROBLEM. `sync/balance-sync/publication-gate.ts` answers "may
-- this portfolio snapshot be published?" with one seven-branch UNION ALL, and
-- every branch is scoped by `wallet_address = ANY($1::text[])`:
--
--   agent_activity              1 branch   (already indexed, migration 044)
--   wallet_intents              2 branches (025)
--   wallet_transaction_intents  2 branches (087)
--   wallet_wrap_intents         2 branches (096)
--
-- All three intent tables were created with indexes on `session_id`, on the
-- TTL/repair status predicates and on `activity_id` - none on
-- `wallet_address`, because until WP8 nothing read them by wallet. The gate
-- does, and it does so in the worst possible place: inside the publishing
-- transaction, AFTER `LOCK TABLE agent_activity IN SHARE MODE` and under a
-- `SET LOCAL lock_timeout` of two seconds
-- (`sync/balance-sync/snapshot-publication.ts`). Every millisecond the gate
-- spends sequentially scanning intent tables is a millisecond in which no
-- `agent_activity` row can be written for ANY wallet, and a millisecond that
-- pushes concurrent publishers toward the 55P03 `lock_unavailable` path that
-- silently skips a snapshot.
--
-- Measured on real PostgreSQL 18 (pgvector/pgvector:0.8.2-pg18-trixie) with
-- 3,000 rows per intent table across 300 wallets, two wallets probed, by
-- `__tests__/integration/repos/snapshot-publication-indexes.int.test.ts` - which
-- re-measures BOTH plans on every run against the gate's own SQL rather than
-- trusting the numbers written here. One such run:
--
--   before 098   total cost 26148.69, 2261 buffers, a SEQUENTIAL SCAN on each
--                of wallet_intents (x2 branches), wallet_transaction_intents
--                and wallet_wrap_intents (x2)
--   after 098    total cost   554.52,  455 buffers, every wallet predicate on
--                the three tables served by a bitmap scan over its new index,
--                no sequential scan left
--
-- `agent_activity` is unchanged and needs nothing: the same run plans its two
-- branches through `idx_agent_activity_wallet` (044) and
-- `idx_agent_activity_tx_hash`, and the cycle-start fence through
-- `idx_agent_activity_wallet` at cost 60.29.
--
-- Cost and buffer counts are per-run measurements, not guarantees. The
-- regression contract that test asserts is the PLAN SHAPE - the named index
-- appears, no sequential scan remains - never a timing or a cost threshold.
--
-- WHY A PLAIN SINGLE-COLUMN BTREE, and nothing cleverer.
--   * The predicate is equality against an array: `= ANY($1::text[])`. A btree
--     on `(wallet_address)` serves that directly, as one bitmap-index scan per
--     array element, which is exactly the shape the planner picks below.
--   * NOT a partial index. The two branches per table select disjoint status
--     sets (live statuses; hash-carrying unresolved statuses), and a third
--     reader would need a third partial predicate. A status-partial index also
--     stops being usable the moment a status is added to a CHECK, which is a
--     recurring event on these tables.
--   * NOT a composite `(wallet_address, status)`. Status selectivity is low
--     (the blocking statuses are a minority of a small table) and the extra
--     column would buy nothing the recheck on the heap tuple does not already
--     do, while widening every intent write.
--   * NOT `(wallet_address, created_at DESC)` like `idx_agent_activity_wallet`.
--     That index exists to serve the ORDERED activity feed; the gate does not
--     order intents at all, it counts reasons and stops at 50.
--
-- ROLLBACK CONTRACT. These are pure access-path objects: no column, no
-- constraint, no row is touched, so the migration is behaviour-preserving in
-- both directions. Old code runs unchanged against the new schema (it simply
-- gets faster plans), and rolling back is `DROP INDEX idx_wallet_intents_wallet,
-- idx_wallet_transaction_intents_wallet, idx_wallet_wrap_intents_wallet;` with
-- no data repair and no reader/writer ordering requirement. Forward-only and
-- idempotent via IF NOT EXISTS, per the runner's contract.
--
-- Built WITHOUT `CONCURRENTLY` deliberately: the runner applies each migration
-- inside a transaction (`CREATE INDEX CONCURRENTLY` cannot run there), these
-- tables are small local intent logs, and the desktop app runs migrations at
-- startup before any wallet lane is admitted, so the brief ACCESS EXCLUSIVE
-- lock has no concurrent writer to block.

CREATE INDEX IF NOT EXISTS idx_wallet_intents_wallet
  ON wallet_intents (wallet_address);

CREATE INDEX IF NOT EXISTS idx_wallet_transaction_intents_wallet
  ON wallet_transaction_intents (wallet_address);

CREATE INDEX IF NOT EXISTS idx_wallet_wrap_intents_wallet
  ON wallet_wrap_intents (wallet_address);
