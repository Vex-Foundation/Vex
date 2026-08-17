-- 081: `swap_prequotes.kind` admits the four Morpho Blue BORROW operations.
--
-- Date: 2026-08-17. Owner directive: "integruj 100% morpho" (E3c, the borrow
-- lane of the Morpho integration plan).
--
-- -- NUMBERING ---------------------------------------------------------------
--
-- `db/migrate.ts` applies only migrations whose version is GREATER than
-- `MAX(schema_version)`, so this file is forward-only for every history that
-- has run 080. Verified 2026-08-17: 080 is the highest sibling and no file
-- claims 081. The live constraint name is `swap_prequotes_kind_check`, last
-- defined by migration 080.
--
-- -- WHY FOUR NEW KINDS, ONE PER OPERATION -----------------------------------
--
-- `kind` is not a label: it is a predicate in BOTH prequote gate reads
-- (`findLatestFreshByMatch` and `existsFreshFailByMatch` in
-- `db/repos/swap-prequotes.ts`). Two operations that share a kind can authorize
-- each other whenever the remaining match material happens to agree. On a
-- Morpho Blue market the four borrow-lane operations run against the SAME
-- market id and the SAME wallet, and two of them can carry the same raw
-- amount, so a single shared kind (for example one `lend_borrow_operate`) would
-- let a collateral-supply quote authorize a BORROW execute: the wallet would
-- have approved putting money in and been charged with taking debt out. That is
-- the same reasoning migration 054 used to split `lp_add` from `lp_remove` and
-- migration 080 used to split `lend_deposit` from `lend_withdraw`, applied to a
-- lane where the mismatch costs a liquidation rather than a rounding error.
--
-- The four kinds, one per operation:
--   - 'lend_supply_collateral'   : collateral token -> market position,
--   - 'lend_withdraw_collateral' : market position -> collateral token,
--   - 'lend_borrow'              : loan token drawn as debt,
--   - 'lend_repay'               : loan token returned against debt.
--
-- THERE IS NO AUTHORIZATION KIND, deliberately. The borrow leg calls Morpho
-- Blue DIRECTLY with `msg.sender == onBehalf` (confirmed on an Anvil Base
-- fork), so no `setAuthorization` is ever granted to an adapter and there is no
-- authorization operation for a kind to describe. A kind admitted "just in
-- case" would be a predicate nothing validates.
--
-- The `agent_activity` `event_role` for all four operations remains the
-- EXISTING 'lend_borrow_operate' (in the vocabulary since migration 049,
-- admitted on the eip155 `lend` arm by 079). This migration adds NO role and
-- touches NO `agent_activity` constraint: it is `swap_prequotes.kind` only.
-- The gate needs per-operation resolution because it authorizes money moves;
-- the ledger reads the lane as one activity, which is why the two vocabularies
-- legitimately differ in granularity here.
--
-- -- EXACT PREDICATE DELTA ----------------------------------------------------
--
-- `swap_prequotes_kind_check`
--   OLD (080):
--     kind IN ('swap', 'bridge', 'redeem', 'mint', 'redeem_py', 'lp_add',
--              'lp_remove', 'sy_mint', 'sy_redeem', 'lp_remove_dual',
--              'lp_add_keep_yt', 'pt_rollover', 'lp_transfer', 'lp_to_pt',
--              'lend_deposit', 'lend_withdraw')
--   NEW:
--     kind IN ('swap', 'bridge', 'redeem', 'mint', 'redeem_py', 'lp_add',
--              'lp_remove', 'sy_mint', 'sy_redeem', 'lp_remove_dual',
--              'lp_add_keep_yt', 'pt_rollover', 'lp_transfer', 'lp_to_pt',
--              'lend_deposit', 'lend_withdraw', 'lend_supply_collateral',
--              'lend_withdraw_collateral', 'lend_borrow', 'lend_repay')
--   Delta: four added members, appended. Every one of the other sixteen members
--   is byte-identical to 080. A CHECK cannot be amended in place, so the whole
--   predicate is restated with the drop-and-re-add-named pattern of
--   034/035/054/080.
--
-- -- SAFETY --------------------------------------------------------------------
--
-- EXPAND-ONLY. The IN list only gains members and loses none, so every row that
-- satisfied the 080 CHECK satisfies this one BY CONSTRUCTION: no backfill, no
-- data mutation, no column added or dropped, no narrowing. The constraint
-- therefore re-adds VALIDATING (no `NOT VALID` needed), because the scan of
-- existing rows cannot fail. NO ROWS ARE REWRITTEN: no Morpho borrow prequote
-- has ever been recorded under another kind (the borrow execute surface does
-- not exist yet), so there is nothing to relabel, and relabelling would be
-- wrong anyway since `kind` is hashed into the row's match material. Rollback
-- to the 080 predicate is clean only while no row of the four new kinds exists.
--
-- The TS union `PrequoteKind` and this CHECK are held in lockstep by
-- `__tests__/vex-agent/db/repos/swap-prequotes-kind-lockstep.test.ts`.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final.

ALTER TABLE swap_prequotes
  DROP CONSTRAINT IF EXISTS swap_prequotes_kind_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'swap_prequotes_kind_check'
  ) THEN
    ALTER TABLE swap_prequotes
      ADD CONSTRAINT swap_prequotes_kind_check
      CHECK (kind IN ('swap', 'bridge', 'redeem', 'mint', 'redeem_py', 'lp_add', 'lp_remove', 'sy_mint', 'sy_redeem', 'lp_remove_dual', 'lp_add_keep_yt', 'pt_rollover', 'lp_transfer', 'lp_to_pt', 'lend_deposit', 'lend_withdraw', 'lend_supply_collateral', 'lend_withdraw_collateral', 'lend_borrow', 'lend_repay'));
  END IF;
END$$;
