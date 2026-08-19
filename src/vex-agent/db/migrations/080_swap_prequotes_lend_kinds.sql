-- 080: `swap_prequotes.kind` admits the two Morpho vault lend directions.
--
-- Date: 2026-08-17. Owner approval: "Tak, buduj 080" (E3b-2, the prequote-gate
-- schema batch of the Morpho integration plan).
--
-- -- NUMBERING ---------------------------------------------------------------
--
-- `db/migrate.ts` applies only migrations whose version is GREATER than
-- `MAX(schema_version)`, so this file is forward-only for every history that
-- has run 079. Verified 2026-08-17: 079 is the highest sibling and no file
-- claims 080. The live constraint name is `swap_prequotes_kind_check`, last
-- defined by migration 054.
--
-- -- WHY TWO NEW KINDS, AND NOT A REUSE OF `swap` -----------------------------
--
-- `kind` is not a label: it is a predicate in BOTH prequote gate reads
-- (`findLatestFreshByMatch` and `existsFreshFailByMatch` in
-- `db/repos/swap-prequotes.ts`). Two actions that share a kind can authorize
-- each other whenever their material happens to agree, and an action filed
-- under `swap` can be authorized by an ordinary DEX quote. That is the exact
-- bug migration 054 was written to fix: Pendle's SY wrap/unwrap pair had been
-- stored under `swap` with the comment "no migration", so a wrap quote could
-- authorize an unwrap execute and nothing but the venue label separated either
-- from a real DEX trade. Reusing `swap` for a Morpho vault write would
-- reintroduce that hole verbatim, so 054's own rationale forbids it.
--
-- For the same reason the two DIRECTIONS get one kind each rather than a
-- shared `lend` kind. A deposit and a withdraw against the same vault and the
-- same wallet differ only in direction; under one kind, a deposit quote could
-- authorize a withdraw execute (and the reverse) whenever the remaining
-- material agreed. 054 split `lp_add` from `lp_remove` on precisely this
-- reasoning, and this migration mirrors it:
--   - 'lend_deposit'  : Morpho vault supply (asset -> vault shares),
--   - 'lend_withdraw' : Morpho vault withdraw (vault shares -> asset).
--
-- The names match the `event_role` vocabulary that migration 079 already uses
-- on the `agent_activity` `lend` arm, so one execution reads under one word in
-- both the gate and the ledger.
--
-- -- EXACT PREDICATE DELTA ----------------------------------------------------
--
-- `swap_prequotes_kind_check`
--   OLD (054):
--     kind IN ('swap', 'bridge', 'redeem', 'mint', 'redeem_py', 'lp_add',
--              'lp_remove', 'sy_mint', 'sy_redeem', 'lp_remove_dual',
--              'lp_add_keep_yt', 'pt_rollover', 'lp_transfer', 'lp_to_pt')
--   NEW:
--     kind IN ('swap', 'bridge', 'redeem', 'mint', 'redeem_py', 'lp_add',
--              'lp_remove', 'sy_mint', 'sy_redeem', 'lp_remove_dual',
--              'lp_add_keep_yt', 'pt_rollover', 'lp_transfer', 'lp_to_pt',
--              'lend_deposit', 'lend_withdraw')
--   Delta: two added members, appended. Every other member is byte-identical
--   to 054. A CHECK cannot be amended in place, so the whole predicate is
--   restated with the drop-and-re-add-named pattern of 034/035/054.
--
-- -- SAFETY --------------------------------------------------------------------
--
-- EXPAND-ONLY. The IN list only gains members and loses none, so every row
-- that satisfied the 054 CHECK satisfies this one BY CONSTRUCTION: no
-- backfill, no data mutation, no column added or dropped, no narrowing. The
-- constraint therefore re-adds VALIDATING (no `NOT VALID` needed), because the
-- scan of existing rows cannot fail. NO ROWS ARE REWRITTEN: no Morpho prequote
-- has ever been recorded under another kind (the vault execute surface does
-- not exist yet), so there is nothing to relabel, and relabelling would be
-- wrong anyway since `kind` is hashed into the row's match material. Rollback
-- to the 054 predicate is clean only while no `lend_deposit` / `lend_withdraw`
-- row exists.
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
      CHECK (kind IN ('swap', 'bridge', 'redeem', 'mint', 'redeem_py', 'lp_add', 'lp_remove', 'sy_mint', 'sy_redeem', 'lp_remove_dual', 'lp_add_keep_yt', 'pt_rollover', 'lp_transfer', 'lp_to_pt', 'lend_deposit', 'lend_withdraw'));
  END IF;
END$$;
