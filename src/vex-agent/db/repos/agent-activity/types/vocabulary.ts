/**
 * Kind, generic-kind, event-role, and chain-family vocabulary for
 * `agent_activity` rows. Pure types, no imports.
 */

/**
 * Swap rows (Phase 1), bridge rows (Phase 2, migration 045), or the W5
 * (migration 049) `lend`/`prediction` rows. Jupiter swaps reuse the existing
 * `swap` kind (protocol='jupiter') rather than adding a fifth kind.
 * `wrap` is migration 051 (native <-> wrapped-native, no route/price/slippage);
 * `yield` is migration 053 (Pendle PT/YT/PY/LP/claim, protocol='pendle') — kept
 * out of `swap` because `py.mint` is a 1->2 split, `lp.add` a deposit and
 * `yield_claim` an income sweep with NO input leg, none of which a swap's
 * route/price/counterparty assertions describe.
 * `launch` is migration 062 (Trench Express token creation on Robinhood Chain
 * 4663, protocol='trench'): ONE payable `create` transaction that mints a token
 * and — when a prebuy was asked for — buys some of it in the SAME transaction.
 * The prebuy is therefore a LEG of the launch, recorded in this row's ordinary
 * first-leg columns (native in, the new token out), NEVER a second `swap` row
 * sharing the create's tx hash.
 */
export type AgentActivityKind =
  | "swap"
  | "bridge"
  | "lend"
  | "prediction"
  | "wrap"
  | "yield"
  | "launch"
  /**
   * A creator-fee CLAIM (migration 082, owner decision 2026-08-19). Its own
   * kind rather than a launch: it signs its own transaction, pays two assets,
   * spends nothing, and happens long after the launch it belongs to - so filing
   * it under `launch` would put a payout inside every launch feed, filter and
   * count. `pools_fee` stays on `launch`, because it IS the fee leg of one.
   */
  | "claim"
  /**
   * An agent WALLET SEND (migration 084) - `WalletSendPrepare` /
   * `WalletSendConfirm`. Its own kind rather than a `swap` role: a send has no
   * route, no price, no slippage and no counterparty, only the one leg that left
   * the wallet, so the `swap` arm's assertions would all describe a trade that
   * never happened. The name matches the on-wire ERC-20 `Transfer` semantics and
   * the display kind the deprecated `proj_activity` lane already derived for a
   * legacy send.
   */
  | "transfer"
  /**
   * A GENERIC SIGNED TRANSACTION (migration 087) - `WalletEvmTransactionPrepare`
   * / `Confirm` and their Solana twins. Its own kind rather than a `transfer`
   * role: the transfer arm carries exactly one input leg, and a proposal Vex did
   * not build cannot honestly populate one. An approve moves nothing at all, a
   * contract call moves whatever the contract decides, and an SPL instruction
   * set may move several things at once - so a single-asset leg here would be a
   * number nobody proved. The row records WHAT WAS SIGNED (the decoded effect,
   * through its role) and the chain outcome, and nothing about amounts it cannot
   * establish.
   */
  | "transaction";

/**
 * Kinds valid through the GENERIC write path (`./swap-intent.js` +
 * `./swap-lifecycle.js` — `createAgentActivityIntent`/
 * `createAgentActivityPreBroadcastFailure`/`createPendingActivityEvent`/
 * `recordPreBroadcastFailure`). `bridge` is deliberately excluded: it has
 * its own dedicated `./bridge-intent.js`/`./bridge-lifecycle.js` API with a
 * different required shape (route endpoints, a logical `bridge_fill_expected`
 * row, provider-order-id CAS) — routing a bridge row through the generic
 * path would bypass that machinery and create a malformed row.
 */
export type AgentActivityGenericKind = Exclude<AgentActivityKind, "bridge">;

/**
 * Event roles. Phase-1 swap roles, the Phase-2 bridge roles (migration 045),
 * and the W5 lend/prediction roles (migration 049 — one role per on-chain
 * tx; a lend `/operate` delta shape lives in `intent_params`, not in this
 * vocabulary). `bridge_fill_expected` is the LOGICAL-row marker (B2) — exactly
 * one per execution, carrying the route endpoints + amounts +
 * `provider_order_id` that every feed/dedup/in-flight-guard keys on.
 * `bridge_deposit` is the Vex-signed origin leg; `bridge_fee` (migration 050)
 * is the Vex integrator-fee transfer — the FINAL Vex-signed origin leg, taken
 * only after the deposit succeeded, so a bridge that never lands never pays a
 * fee. It was recorded as `allowance` until 050 (see
 * `src/tools/bridge-fee/constants.ts`); `bridge_deposit` was and remains
 * disqualified for it because the bridge repair sweep correlates the provider
 * order by selecting the sibling `bridge_deposit` row.
 * `bridge_fill_observed`/`bridge_refund` are externally-observed
 * (solver-signed) evidence rows.
 * `predict_sell` is a SINGLE-position close (`solana.predict.sell` ->
 * `DELETE /positions/{positionPubkey}`, one activity row); `predict_close`
 * is reserved for the `closeAll` bulk fan-out (`DELETE /positions`, N
 * independent activity rows, one per tx). Both cover Forecast(bisonfi)
 * orders identically — the provider distinction lives in how the row is
 * SUBMITTED (managed `/execute` vs the generic path), never in the role.
 * `wrap`/`unwrap` are migration 051. The six `yield_*` roles are migration 053
 * (Pendle): `yield_pt`/`yield_yt`/`yield_sy` are one-in-one-out, `yield_py`
 * carries a SECOND leg on exactly one side (mint splits 1->PT+YT, redeem burns
 * PT+YT->1), `yield_lp` may carry one for the dual add/remove variants, and
 * `yield_claim` has NO input leg at all. `yield_sy` is the SY wrapper leg
 * (`pendle.sy.mint`/`pendle.sy.redeem`) — a wrap, never a split, and therefore
 * barred from the second-leg family. A Pendle ERC-20 approval REUSES `allowance` /
 * `allowance_reset` rather than forking a Pendle-specific role.
 * `token_launch` is migration 062 — ONE role for the whole Trench launch, not
 * two. A launch has no allowance step (the creation fee and the prebuy are both
 * paid in NATIVE ETH as `msg.value`, and native value needs no ERC-20 approval)
 * and no separate prebuy role, because the prebuy happens in the same
 * transaction and rides this row's first-leg columns. It is likewise barred from
 * the Option-C second-leg family: a create-with-prebuy is one-in one-out.
 * `trench_fee` is migration 063 — Vex's 25 bps integrator fee on Trench Express,
 * a SEPARATE native transfer to the treasury that runs after the trade or launch
 * confirms. `bridge_fee` could not be reused: the kind↔role binding admits it
 * only on the `kind='bridge'` arm. It is admitted on the `swap` AND `launch`
 * arms because a trade fee rides a `swap` execution and a launch fee rides a
 * `launch` one, and they are the same kind of leg.
 * `swap_fee` is migration 066 — Vex's 25 bps integrator fee on a SWAP venue whose
 * router takes no fee parameter (Uniswap V2 Router02 / V3 SwapRouter02), charged
 * as a separate transfer of the INPUT token that runs after the swap confirms.
 * Admitted on the `swap` arm only. Neither `bridge_fee` (barred by the binding
 * to `kind='bridge'`) nor `trench_fee` (which names another venue, and whose
 * rows answer "what did Trench Express earn") could carry it. The name is
 * venue-neutral so a later fee-parameterless swap venue reuses it.
 */
export type AgentActivityEventRole =
  | "allowance_reset"
  | "allowance"
  | "swap"
  | "bridge_deposit"
  | "bridge_fee"
  | "bridge_fill_expected"
  | "bridge_fill_observed"
  | "bridge_refund"
  | "lend_deposit"
  | "lend_withdraw"
  | "lend_borrow_operate"
  | "predict_buy"
  | "predict_sell"
  | "predict_claim"
  | "predict_close"
  | "wrap"
  | "unwrap"
  | "yield_pt"
  | "yield_yt"
  | "yield_py"
  | "yield_lp"
  | "yield_sy"
  | "yield_claim"
  | "token_launch"
  | "trench_fee"
  | "swap_fee"
  // Migration 082. `pools_fee` is Vex's integrator fee on a pools.fun launch and
  // rides the `launch` arm - its own role rather than `trench_fee`, which names
  // a different venue whose feeds and repair sweeps select on it.
  // `pools_claim` is a creator fee claim: ONE row whose two OUTPUT legs are the
  // launched token and the paired asset that `collectAndClaim` returns
  // together, and it rides the `claim` KIND rather than `launch`.
  | "pools_fee"
  | "pools_claim"
  /**
   * Migration 084 - the whole of an agent wallet send, on either chain family.
   * ONE role for the transaction, carrying the INPUT leg only - the asset the
   * wallet spent. There is no output leg, because nothing comes back, and no
   * second leg. An NFT send rides this same role with the CONTRACT address as
   * the token identity, `tokenDecimals: 0`, and the token id in the symbol.
   */
  | "wallet_transfer"
  /**
   * Migration 087 - the four roles of the generic signing path, one per DECODED
   * EFFECT, so a feed can say what the transaction did without re-decoding
   * calldata. They are PREFIXED because this enum is global: a bare `approve`
   * would sit beside `allowance` and read as the same thing on another arm.
   *
   * None of them carries an asset leg. That is the point of the kind: the
   * effect is decoded and displayed, and what it moved is only ever what the
   * chain later proves.
   */
  | "tx_approve"
  | "tx_contract_call"
  | "tx_native_transfer"
  | "tx_spl_instruction_set"
  /**
   * Migration 088 - Vex's 25 bps integrator fee on the GENERIC EVM signing
   * lane, charged on the transaction's own native value as a separate treasury
   * transfer that runs only after that transaction confirms.
   *
   * Its own role rather than `swap_fee` or `trench_fee`: both of those name a
   * venue whose feeds and repair sweeps select on them, and neither is admitted
   * on the `transaction` arm of the kind/role binding. It is EVM-ONLY, bound by
   * `agent_activity_tx_vex_fee_eip155` - no Solana fee-leg runtime exists on
   * this lane, and the database enforces the gap rather than trusting the
   * writer to observe it.
   */
  | "tx_vex_fee";

/** Chain family discriminator (045) — drives the nonce matrix + explorer-link resolution. */
export type BridgeChainFamily = "eip155" | "solana";
