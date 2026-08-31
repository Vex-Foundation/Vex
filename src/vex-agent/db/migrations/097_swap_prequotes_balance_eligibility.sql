-- 097_swap_prequotes_balance_eligibility.sql - a quote that the wallet cannot
-- pay for is a quote that authorizes nothing.
--
-- RUNS AFTER 096.
--
-- Migration 095 gave `eligibility_kind` five values, all of them about the
-- ROUTE: whether it could be priced, whether its impact was inside the ceiling,
-- whether its snapshot could be stored. None of them asked the other question a
-- swap depends on - whether the wallet holds what the swap is about to spend.
--
-- Three values are added, and nothing existing changes meaning:
--
--   insufficient_balance      The source asset does not cover the principal.
--   balance_unavailable       A balance the swap depends on could not be READ.
--                             Deliberately NOT the same value as the one above:
--                             "the wallet is short" and "we do not know what
--                             the wallet holds" are different facts with
--                             different remedies, and a merged value would make
--                             the second unrecoverable from the row.
--   gas_reserve_insufficient  Native covers the principal but not every fee leg
--                             the swap will broadcast plus the measured
--                             follow-up reserve. An ERC-20 swap reaches this
--                             too: a token swap still pays its gas in native.
--
-- WHY A ROW IS STILL WRITTEN. An ineligible quote records a row precisely so it
-- SUPERSEDES the older priced row for the same identity (the claim's newest-row
-- clause, migration 095). Skipping the write would leave the stale executable
-- quote standing, which is the hole 095 closed.
--
-- EXPAND ONLY, and safe on a table that already holds user rows: the constraint
-- is widened, never narrowed, so every existing value stays legal and no row is
-- rewritten. Forward-only, and idempotent as a PAIR: the constraint is dropped
-- by name (IF EXISTS, so a first run on a table without it is fine) before it
-- is recreated, so re-running the file yields the same constraint.
--
-- ROLLBACK. Narrowing this vocabulary again is a SEPARATE forward migration,
-- and it may only run after the rows carrying the removed values have been
-- resolved: dropping a value the table still holds would leave rows the CHECK
-- rejects on their next update.

ALTER TABLE swap_prequotes
  DROP CONSTRAINT IF EXISTS swap_prequotes_eligibility_kind_check;

ALTER TABLE swap_prequotes
  ADD CONSTRAINT swap_prequotes_eligibility_kind_check
  CHECK (eligibility_kind IN (
    'executable',
    'unpriceable_output',
    'excessive_impact',
    'oversize_snapshot',
    'provider_usd_invalid',
    'insufficient_balance',
    'balance_unavailable',
    'gas_reserve_insufficient'
  ));
