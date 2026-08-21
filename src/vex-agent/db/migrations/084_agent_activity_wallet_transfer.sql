-- 084_agent_activity_wallet_transfer.sql - agent wallet sends become activity rows
--
-- RUNS AFTER 083.
--
-- WHAT THIS ADDS. One kind, `transfer`, and one role, `wallet_transfer`, so an
-- agent wallet send (`wallet_send_prepare` / `wallet_send_confirm`) lands in
-- `agent_activity` like every other money-moving action.
--
-- WHY IT WAS MISSING, and why that is a defect rather than a gap. A transfer
-- persisted only into `wallet_intents`, which no feed reads. The transaction was
-- real, the funds moved, and the agent's own history showed nothing - while the
-- executors carried comments promising a capture pipeline that never ran on the
-- internal tool route. Every other lane here (swap, bridge, lend, prediction,
-- wrap, yield, launch, claim) writes a durable row BEFORE it signs; a transfer
-- was the one money path with no durable record at all.
--
-- WHY ITS OWN KIND rather than a role on `swap`. A send has no route, no price,
-- no slippage and no counterparty: it has ONE leg, the asset that left the
-- wallet, and a destination that is deliberately not recorded. Filing it under
-- `swap` would state a trade that never happened - the exact falsehood
-- migration 051 (`wrap`) and 053 (`yield`) each record the cost of. The name
-- `transfer` matches the on-wire ERC-20 `Transfer` semantics and the display
-- kind the deprecated `proj_activity` lane already derived for a legacy send, so
-- nothing a user has already seen changes its label.
--
-- THE `transfer` ARM CARRIES AN INPUT LEG AND NOTHING ELSE. The wallet spends
-- the asset, so the row populates the `token_in_*` / `amount_in_*` columns. It
-- takes no output leg (there is no asset coming back) and no second leg
-- (`agent_activity_second_leg_roles_only`, migration 053/082, is deliberately
-- NOT restated here - `wallet_transfer` is absent from its allowlist, which is
-- the correct answer). An NFT send rides the same kind and role: the token
-- identity is the CONTRACT address with `decimals = 0`, the token id travels in
-- the symbol, and a pseudo-address is never minted.
--
-- CONSTRAINTS DELIBERATELY NOT RESTATED, and why each is unaffected:
--   * `agent_activity_kind_family_binding` (079) - its predicate reads
--     `kind NOT IN ('lend', 'prediction') OR ...`, so `transfer` satisfies it
--     through the leading disjunct on EITHER family, exactly as `swap`, `wrap`,
--     `yield`, `launch` and `claim` already do. A transfer arm would be a
--     disjunct nothing needs, and restating the constraint would risk dropping
--     079's `eip155` lend arm.
--   * `agent_activity_evm_signed_leg_has_nonce` (045) - family-scoped, not
--     kind-scoped. A staged EVM transfer row satisfies it because the writer
--     signs LOCALLY first and stages the hash together with the prepared
--     request's nonce (see `send/activity-writer.ts`), which is precisely why
--     the writer was restructured rather than the CHECK relaxed.
--   * `agent_activity_solana_no_nonce` (045) - family-scoped; a Solana transfer
--     row leaves `nonce` NULL.
--   * `agent_activity_solana_staged_has_evidence` (049) - family-scoped. A
--     Solana transfer stages its base58 signature together with the
--     `recent_blockhash` / `last_valid_block_height` its sign-only preparation
--     step returns, so the evidence exists before anything is submitted.
--   * `agent_activity_second_leg_roles_only` (053/082) - see above.
--
-- All three restatements below carry every existing member across byte-for-byte
-- from migration 082 (the current state). A CHECK cannot be amended in place, so
-- a restatement that dropped a member would make those rows unwritable.

-- ── 1. The role vocabulary ────────────────────────────────────────────────
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
    'wallet_transfer'
  ));

-- ── 2. The kind vocabulary ────────────────────────────────────────────────
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_valid
  CHECK (kind IN ('swap', 'bridge', 'lend', 'prediction', 'wrap', 'yield', 'launch', 'claim', 'transfer'));

-- ── 3. The kind <-> role binding ──────────────────────────────────────────
--
-- The `transfer` arm carries exactly ONE role. A send has no allowance step
-- (a native send approves nothing, and an ERC-20 send moves the caller's own
-- balance) and no fee leg of its own. The CHECK body itself stays comment-free
-- and apostrophe-free, because the constraint evaluators that test these
-- bindings parse the body as SQL rather than as prose.
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
  );
