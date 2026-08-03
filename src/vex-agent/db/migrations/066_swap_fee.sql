-- 066: Vex's 25 bps integrator fee on Uniswap — the `swap_fee` activity role.
--
-- ── NUMBERING ──────────────────────────────────────────────────────────────
--
-- `db/migrate.ts` applies only migrations whose version is GREATER than
-- `MAX(schema_version)`, so this file is forward-only for every history that
-- has run 064 (or a concurrently-landing 065). Verified 2026-08-03: no sibling
-- file claims 066.
--
-- ── WHY THE FEE NEEDS A ROLE OF ITS OWN ────────────────────────────────────
--
-- Vex charges 25 bps on the INPUT token of every Uniswap swap. Uniswap's V2
-- Router02 and V3 SwapRouter02 — the only routers this venue is pinned to —
-- expose NO integrator-fee parameter (unlike KyberSwap's `feeReceiver` or
-- Jupiter's referral account), so the fee can only be Vex's OWN transfer of the
-- input token: a SEPARATE transaction, signed AFTER the swap confirms.
--
-- A separate transaction needs its own `agent_activity` row: it has its own
-- hash, its own nonce, and its own success/failure. It must NOT instead be
-- recorded through the `vex_fee_*` columns (`AgentActivityVexFeeCharge`), which
-- exist for venues that take the fee INSIDE the transaction being recorded and
-- where it therefore has no row. Setting both would store the same money twice —
-- `db/repos/agent-activity/types.ts` states this rule explicitly.
--
-- NEITHER `bridge_fee` NOR `trench_fee` can be reused, and that is what forces a
-- migration rather than a code change:
--   - `bridge_fee` is admitted by `agent_activity_kind_role_binding` ONLY on the
--     `kind = 'bridge'` arm; a Uniswap fee row carries `kind = 'swap'`, so the
--     database would reject it. It would also be untrue: the bridge repair
--     sweeps and the bridge feed both select on `bridge_*` roles.
--   - `trench_fee` IS admitted on the `swap` arm, but it names the Trench
--     Express venue and its rows are native-ETH transfers on one chain. A
--     Uniswap fee row is an ERC-20 (or native) transfer on any Uniswap
--     deployment; filing it under the Trench role would make every
--     "how much did Trench Express earn" question wrong by construction.
--
-- So `swap_fee` joins the role vocabulary and the `swap` arm of the binding.
-- ONLY the `swap` arm: a Uniswap fee always rides a swap execution. A
-- `swap_fee` row on a `bridge`, `lend`, `prediction`, `wrap`, `yield` or
-- `launch` execution would be a mislabelling, and the CHECK is what makes that a
-- database fact rather than a convention.
--
-- The name is venue-NEUTRAL on purpose: it is the fee leg of a `kind = 'swap'`
-- execution, and any future swap venue whose router has no fee parameter
-- records its separate fee transfer here instead of forking a fourth role.
--
-- Local signing: `swap_fee` is added to `hashless-recovery.ts`'s
-- `LOCALLY_SIGNABLE_ACTIVITY_ROLES` in the same change, beside `bridge_fee` and
-- `trench_fee`. A fee leg planned but never signed — because the swap reverted,
-- was ambiguous, or the process died between intent creation and staging — is
-- definitively not-attempted and must stay reapable instead of pending forever.
--
-- No new `kind`: the fee always belongs to an existing `swap` execution. No new
-- `failure_code`: `mined_revert`, `broadcast_error` and `unknown` already
-- describe every way a plain token transfer can fail.
--
-- EXPAND-ONLY. New vocabulary member on two CHECKs; no new column, no backfill,
-- no column dropped, no predicate narrowed. Rollback is clean only while no
-- `swap_fee` row exists.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final.

-- ── 1. `swap_fee` joins the role vocabulary ─────────────────────────────────

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_event_role_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_event_role_valid') THEN
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
        'swap_fee'
      ));
  END IF;
END$$;

-- ── 2. `swap_fee` on the `swap` arm of the binding ──────────────────────────
--
-- Re-stated in full (the drop-and-re-add-named pattern of 034/035/045/049/050/
-- 062/063): a CHECK cannot be amended in place, so the whole predicate is
-- rewritten with the `swap` arm widened and every other arm byte-identical
-- to 063.

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_role_binding;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_role_binding') THEN
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
        (kind = 'lend' AND event_role IN ('lend_deposit', 'lend_withdraw', 'lend_borrow_operate'))
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
          'token_launch', 'trench_fee'
        ))
      );
  END IF;
END$$;
