-- Stage A4b pass 7 - `tx_vex_fee`: Vex's 25 bps integrator fee on the GENERIC
-- EVM signing lane (`WalletEvmTransactionPrepare` / `WalletEvmTransactionConfirm`).
--
-- WHAT THE ROW IS. A SEPARATE native transfer to the Vex treasury, 25 bps of the
-- signed transaction's own native value, signed only AFTER that transaction has
-- confirmed on-chain. It is a CHILD LEG of the `transaction` execution
-- (`event_index` 1, beside the transaction's own row at 0), exactly as
-- `trench_fee`, `swap_fee` and `pools_fee` are children of theirs.
--
-- WHY ITS OWN ROLE. `swap_fee` and `trench_fee` each name a venue whose feeds
-- and repair sweeps select on them, and neither is admitted on the `transaction`
-- arm of the kind/role binding. `bridge_fee` is bound to `kind = 'bridge'`
-- outright. Reusing any of them would file a generic signing fee under a venue
-- that did not earn it and would be read as that venue's revenue.
--
-- ── THE EVM-ONLY BINDING, AND WHY THE DATABASE OWNS IT ──────────────────────
--
-- The Solana pair on this lane charges NOTHING, and that gap is deliberate
-- rather than pending. There is no Solana fee-leg runtime here, and the only way
-- to add one would be to append an instruction to the canonical message - the
-- exact bytes the user already read and approved. Rewriting an approved message
-- is forbidden by construction on this lane, so the fee does not exist there.
--
-- `agent_activity_tx_vex_fee_eip155` makes that a rule the database enforces, in
-- the style of 049's `agent_activity_kind_family_binding`. A future Solana fee
-- leg cannot be quietly written under this role: it would be rejected, and
-- whoever adds it has to state the mechanism in a migration first.
--
-- No existing row carries `tx_vex_fee` (the role is new in this file), so every
-- constraint below validates cleanly against every installed database with no
-- NOT VALID and no backfill.
--
-- `tx_vex_fee` joins the four decoded-effect roles on the `transaction` arm of
-- the kind/role binding, and ONLY that arm: it is the fee leg of a generic
-- signed transaction and belongs to the execution it charges for. The CHECK
-- bodies below carry NO inline comments, because the repository's SQL-check
-- evaluator (`__tests__/vex-agent/db/repos/_sql-check-eval.ts`) parses these
-- expressions to answer "would Postgres accept this row?" and has no comment
-- token. The reasoning lives in this header instead.
--
-- Every existing member of the two restated CHECKs is carried across
-- byte-for-byte from 087 (the current state). A CHECK cannot be amended in
-- place, so a restatement that dropped a member would make those rows
-- unwritable.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final.
--
-- Forward-only; idempotent (drop-and-recreate named, 087 pattern).

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_event_role_valid;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_event_role_valid
  CHECK (event_role IN (
    'allowance_reset', 'allowance', 'swap',
    'bridge_deposit', 'bridge_fee', 'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund',
    'lend_deposit', 'lend_withdraw', 'lend_borrow_operate',
    'predict_buy', 'predict_sell', 'predict_claim', 'predict_close',
    'wrap', 'unwrap',
    'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim',
    'token_launch',
    'trench_fee',
    'swap_fee',
    'pools_fee', 'pools_claim',
    'wallet_transfer',
    'tx_approve', 'tx_contract_call', 'tx_native_transfer', 'tx_spl_instruction_set',
    'tx_vex_fee'
  ));

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_role_binding;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_role_binding
  CHECK (
    (kind = 'swap'   AND event_role IN ('allowance_reset', 'allowance', 'swap', 'trench_fee', 'swap_fee'))
    OR
    (kind = 'bridge' AND event_role IN (
      'allowance_reset', 'allowance',
      'bridge_deposit', 'bridge_fee',
      'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund'
    ))
    OR
    (kind = 'lend' AND event_role IN (
      'allowance_reset', 'allowance',
      'lend_deposit', 'lend_withdraw', 'lend_borrow_operate'
    ))
    OR
    (kind = 'prediction' AND event_role IN (
      'predict_buy', 'predict_sell', 'predict_claim', 'predict_close'
    ))
    OR
    (kind = 'wrap' AND event_role IN ('wrap', 'unwrap'))
    OR
    (kind = 'yield' AND event_role IN (
      'allowance_reset', 'allowance',
      'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim'
    ))
    OR
    (kind = 'launch' AND event_role IN (
      'allowance_reset', 'allowance',
      'token_launch', 'trench_fee',
      'pools_fee'
    ))
    OR
    (kind = 'claim' AND event_role IN ('pools_claim'))
    OR
    (kind = 'transfer' AND event_role IN ('wallet_transfer'))
    OR
    (kind = 'transaction' AND event_role IN (
      'tx_approve', 'tx_contract_call', 'tx_native_transfer', 'tx_spl_instruction_set',
      'tx_vex_fee'
    ))
  );

-- THE FAMILY BINDING. See the header: the Solana half of the generic signing
-- lane charges no Vex fee, and this is what stops a future writer from
-- recording one anyway. Written as an implication so every row of every other
-- role is unaffected.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_tx_vex_fee_eip155;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_tx_vex_fee_eip155
  CHECK (event_role <> 'tx_vex_fee' OR chain_family = 'eip155');
