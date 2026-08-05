/**
 * Agent Scan activity repo — shared row + domain types (migrations
 * `044_agent_activity.sql`, `045_bridge_activity.sql`,
 * `049_agent_activity_solana_vocabulary.sql`).
 *
 * Pure types only. Validation (`assertFailureCode`, `sanitizeFailureReason`)
 * lives in `./validation.js`; row → domain mapping (`mapRow`) lives in
 * `./mappers.js`. Consumed by `./swap.js` (Phase 1), `./bridge.js` (Phase 2,
 * migration 045), and the W5 lend/prediction/Jupiter-swap write paths
 * (migration 049) — this module has no DB or business-logic imports. The
 * Solana synthetic chain id itself lives in `src/constants/solana-chain.js`
 * (W5 design REVISION 1 R1), not here — this module stays pure vocabulary.
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
  | "launch";

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
  | "swap_fee";

/** Chain family discriminator (045) — drives the nonce matrix + explorer-link resolution. */
export type BridgeChainFamily = "eip155" | "solana";

/**
 * How many CONSECUTIVE inconclusive verification attempts make a pending row
 * `stalled_verification` (migration 065).
 *
 * 20 ≈ 10 minutes of fast-lane checks or ≈ 20 minutes of global sweeps — long
 * enough that a slow-but-healthy transaction never trips it, short enough that a
 * permanently unverifiable chain (`no_safe_rpc`) is named while the user still
 * remembers the transaction.
 *
 * DERIVED, NEVER STORED. Crossing this threshold changes what the UI and the
 * agent are TOLD; it never changes `status`, and it can never fail a row.
 */
export const STALLED_VERIFICATION_ATTEMPTS = 20;

/**
 * THE BOUND ON `last_verification_reason` (migration 065): a CLOSED SET of our
 * own named codes, and the ONE owner of that vocabulary.
 *
 * It lives here, beside `STALLED_VERIFICATION_ATTEMPTS` and
 * `isStalledVerification`, because the read side of this column already lives
 * here. It used to live in `sync/bridge-activity-repair-contracts.ts` while
 * three sweeps wrote reasons it had never heard of — the EVM sweep's
 * `receipt_not_found`/`lookup_error` and the Solana sweep's five — so the
 * "closed set" was closed over one writer out of three. Every one of them is
 * admitted BY NAME below.
 *
 * WHAT THIS COLUMN MEANS, exactly: *why the last verification CHECK could not
 * conclude*. It is NOT "why the row is pending" and NOT "what evidence the
 * amounts have" — a conclusive-but-non-terminal observation and an
 * amount-evidence fact are different facts in different columns, with their own
 * writers. Putting either here is what made two columns collide.
 *
 * The column is surfaced verbatim to the UI (`AgentScanRow.tsx`) and to the
 * agent (`inspect-views/transactions.ts`), so bounding it by NAME — not by
 * length — is what keeps an unbounded string of someone else's making out of a
 * user-visible field, and it is also what makes the value actionable: the agent
 * can tell `no_safe_rpc` ("we could not look") from `not_yet_confirmed` ("we
 * looked, it is still mining").
 *
 * DELIBERATELY NOT A DB CHECK. Migration 065 is expand-only; a CHECK would make
 * every future reason a migration. The union plus the single writer is the
 * boundary.
 */
/**
 * How long `verification_attempts` must wait between increments (migration 068).
 *
 * The counter measures a STALL, and its threshold is documented in minutes; the
 * lane polls in seconds. Without this throttle a healthy transaction merely
 * unknown to the queried node reaches the 20-attempt threshold in 100 s at the
 * 5 s cadence and renders as "verification stalled" — a lie about what the
 * system knows. With it, `verification_attempts` counts inconclusive WINDOWS,
 * so the threshold keeps its ~10-minute meaning at any polling rate.
 */
export const STALL_INCREMENT_MIN_INTERVAL_MS = 30_000;

export const VERIFICATION_REASONS = [
  // ── The bridge verifier's own (`sync/bridge-activity-repair-verification.ts`) ──
  "malformed_fill_hash",
  "no_safe_rpc",
  "fill_reverted",
  /**
   * PRE-EXISTING ROWS ONLY. Superseded by the four precise reasons below, which
   * say WHY no receipt was obtained; nothing produces it any more.
   */
  "receipt_unavailable",
  "malformed_fill_signature",
  "fill_failed",
  "not_yet_confirmed",
  "signature_status_unavailable",
  // ── The bridge sweep's inconclusive exits ──
  "verification_failed",
  "filled_without_hash",
  "provider_unreachable",
  "chain_mismatch",
  "correlation_mismatch",
  "missing_route",
  "refund_evidence_write_failed",
  // The order-id recovery queue's own inconclusive exits. A crash-after-deposit
  // row has NO order id, so this queue is the only verifier it has: without a
  // reasoned stall it could be retried forever while the UI kept rendering an
  // ordinary healthy pending.
  "recovery_throw",
  "recovery_null",
  "attach_conflict",
  // ── The EVM receipt sweep (`sync/agent-activity-repair.ts`) ──
  "receipt_not_found",
  /** The lookup itself threw — we could not look, as opposed to looking and learning nothing. */
  "rpc_error",
  // ── The Solana sweep (`sync/solana-activity-repair.ts`) ──
  "unreadable_signature_status",
  "get_transaction_unavailable",
  "unreadable_transaction_meta",
  "no_blockhash_evidence",
  "block_height_unavailable",
  // ── The bridge verifier's four-way split of the old `receipt_unavailable` ──
  /** An endpoint echoed the right chain and answered "no receipt yet" — WAIT. */
  "fill_not_mined",
  /** No endpoint ever answered — we cannot see this chain at all. */
  "rpc_unreachable",
  /** Every endpoint answered `eth_chainId` with a different chain than the one we need. */
  "chain_echo_mismatch",
  /**
   * A receipt exists but its status is a value viem cannot read. NOT a revert:
   * claiming a revert we cannot prove is a claim beyond the evidence.
   */
  "unreadable_receipt_status",
  /**
   * The EVM lane looked and NO node knew this hash — no receipt, no mempool
   * entry, and the wallet's own nonce has not passed it. An inconclusive CHECK,
   * not a conclusion: the transaction may be sitting in a node we did not ask,
   * which is exactly why a terminalization built on it needs a bounded window.
   */
  "tx_unknown_to_node",
] as const;

export type VerificationReason = (typeof VERIFICATION_REASONS)[number];

/** Admit a known code, or fall back to the generic one. An UNRECOGNISED string is never stored. */
export function toVerificationReason(raw: string | undefined): VerificationReason {
  return VERIFICATION_REASONS.find((known) => known === raw) ?? "verification_failed";
}

/**
 * `true` iff this row is pending AND we have repeatedly been unable to verify
 * it. NOT a failure — it means "we could not look", which the copy must say.
 */
export function isStalledVerification(
  row: Pick<AgentActivityEvent, "status" | "verificationAttempts">,
): boolean {
  return row.status === "pending"
    && row.verificationAttempts >= STALLED_VERIFICATION_ATTEMPTS;
}

/**
 * A row's stored status (migration 044, widened by 068).
 *
 * `superseded_unproven` is a NON-FAILURE TERMINAL state (owner decision A6). It
 * asserts exactly two things: the hash is NO LONGER TRACKED AS IN FLIGHT, and
 * its inclusion/replacement outcome is UNPROVEN. It does NOT assert that the
 * transaction failed, that nothing was spent, or that a retry is safe — only
 * `nonce_superseded` establishes non-inclusion at all, and even then a
 * replacement reusing the nonce may have carried the same calldata.
 *
 * It carries NO `failure_code`, and no surface may render it as a failure. It
 * exists because the alternative is a row that stays `pending` forever, which is
 * what froze every background portfolio snapshot and kept the repair loops
 * shouting about a hash nothing was going to resolve.
 */
export type AgentActivityStatus =
  | "pending"
  | "confirmed"
  | "definitively_failed"
  | "superseded_unproven";

/** `true` for a status no longer in flight — the predicate every "is it done" question should ask. */
export function isTerminalActivityStatus(status: AgentActivityStatus): boolean {
  return status !== "pending";
}

/**
 * `true` iff this row ended in a state that means the transaction DID NOT
 * happen. `superseded_unproven` is deliberately excluded: we do not know.
 */
export function isFailedActivityStatus(status: AgentActivityStatus): boolean {
  return status === "definitively_failed";
}

/**
 * Closed enum — plan §4.1, grown to 11 members by FIX-SPINE round 1 (finding
 * 7/C1): `mined_revert` is the repair sweep's ONE definitive-failure path (a
 * receipt lookup that came back reverted). `confirmation_timeout` stays in
 * the enum but is RESERVED — nothing in this repo or the repair sweep ever
 * sets it; ambiguity (missing receipt, RPC error, receipt-wait throw) leaves
 * the row `pending` forever instead.
 */
export type AgentActivityFailureCode =
  | "route_not_found"
  | "slippage"
  | "deadline_expired"
  | "insufficient_liquidity"
  | "allowance_or_balance"
  | "chain_unsupported"
  | "simulation_reverted"
  | "mined_revert"
  | "broadcast_error"
  | "confirmation_timeout"
  | "unknown"
  // Bridge terminal codes (045): `bridge_refunded` = the bridge failed but funds
  // were returned to `refundTo` (money back != success); `bridge_failed` = a
  // provider-terminal failure / rejected step set.
  | "bridge_failed"
  | "bridge_refunded"
  // W5 (049): a locally-staged Solana tx whose blockhash proved expired
  // (blockHeight > the row's own persisted last_valid_block_height) before
  // any signature status was ever observed — safe because an expired
  // blockhash can never land. `market_closed` / `position_not_found` /
  // `insufficient_collateral` are NOT new codes (design REVISION 1 R1):
  // they start as structured `failure_reason` text under the existing
  // codes above, not new enum members, unless a future need for
  // code-level filtering justifies growing this enum.
  | "solana_signature_expired";

export interface AgentActivityLegInput {
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  amountHuman?: string;
  amountRaw?: string;
}

/**
 * The Vex integrator fee an IN-TRANSACTION venue took, in token units
 * (migration 050 Part 2) — the FACT behind the nullable `usdVexFeeEst`
 * estimate, so a missing USD price can no longer read as "no fee was charged".
 *
 * Only for venues that take the fee INSIDE the transaction being recorded (the
 * KyberSwap swap leg, a Jupiter swap), where the fee has no row of its own. A
 * BRIDGE fee is a separate transfer with its own `bridge_fee` row whose
 * `tokenIn`/`amountIn` already record it exactly — that row must NOT also set
 * this, or the same money is stored twice.
 *
 * Every field except `tokenSymbol` is REQUIRED, deliberately: a fee amount
 * whose decimals are unknown is unreadable (`"25000"` is 0.025 at 6 decimals
 * and 0.000025 at 9), so a writer that cannot state all of them has no business
 * claiming it knows the fee. `tokenSymbol` is display-only and may be omitted.
 */
export interface AgentActivityVexFeeCharge {
  /** The token the fee was taken IN — the source token on both current venues. */
  readonly tokenAddress: string;
  /** Display only. */
  readonly tokenSymbol?: string;
  /** Decimals of `tokenAddress`, needed to read `amountRaw` at all. */
  readonly tokenDecimals: number;
  /** Atomic units as digits. Never a `number`: a u64/u128 fee exceeds `MAX_SAFE_INTEGER`. */
  readonly amountRaw: string;
  /** Exact-decimal rendering of `amountRaw` at `tokenDecimals`. */
  readonly amountHuman: string;
}

export interface AgentActivityEvent {
  id: number;
  protocolExecutionId: number;
  eventIndex: number;
  eventRole: AgentActivityEventRole;
  recordVersion: number;
  kind: AgentActivityKind;
  protocol: string;
  chainId: number;
  chainSlug: string | null;
  status: AgentActivityStatus;
  failureCode: AgentActivityFailureCode | null;
  failureReason: string | null;
  tokenInAddress: string | null;
  tokenInSymbol: string | null;
  tokenInDecimals: number | null;
  amountInHuman: string | null;
  amountInRaw: string | null;
  tokenOutAddress: string | null;
  tokenOutSymbol: string | null;
  tokenOutDecimals: number | null;
  amountOutHuman: string | null;
  amountOutRaw: string | null;
  executedAmountInHuman: string | null;
  executedAmountInRaw: string | null;
  executedAmountOutHuman: string | null;
  executedAmountOutRaw: string | null;
  // ── Option-C second-leg family (migration 053) — `yield_py`/`yield_lp` ONLY ──
  //
  // Mirrors the first-leg columns name for name. NULL on every other role
  // (`agent_activity_second_leg_roles_only` enforces it), and a second-leg
  // amount may never travel without its token/decimals
  // (`agent_activity_second_leg_amount_has_token`) — a raw amount whose
  // decimals are unknown is the canonical thousandfold-error shape.
  tokenIn2Address: string | null;
  tokenIn2Symbol: string | null;
  tokenIn2Decimals: number | null;
  amountIn2Human: string | null;
  amountIn2Raw: string | null;
  executedAmountIn2Human: string | null;
  executedAmountIn2Raw: string | null;
  tokenOut2Address: string | null;
  tokenOut2Symbol: string | null;
  tokenOut2Decimals: number | null;
  amountOut2Human: string | null;
  amountOut2Raw: string | null;
  executedAmountOut2Human: string | null;
  executedAmountOut2Raw: string | null;
  usdInEst: string | null;
  usdOutEst: string | null;
  /**
   * DEPRECATED (migration 050) — the mixed-meaning column: network gas on a
   * `kyberswap_quote` row, the provider's venue fee on a
   * `jupiter_prediction_order_preview` row, NULL on bridges. Still dual-written
   * with its EXACT historical value so old readers are unaffected; a later
   * contract migration drops it. Read the four `usd*Est` fields below instead.
   */
  usdFeeEst: string | null;
  /**
   * Network gas only, in USD — NOT part of `tx.value`. Kyber records
   * `gasUsd + l1FeeUsd`, so on an OP-stack chain this is legitimately GREATER
   * than the frozen `usdFeeEst`; rows backfilled from before migration 050
   * carry L2-only gas because the L1 component was never recorded.
   */
  usdNetworkGasEst: string | null;
  /** The VENUE's own protocol fee, in USD (Jupiter's prediction order total; Kyber's `extraFee`). Never gas, never the Vex fee. */
  usdVenueFeeEst: string | null;
  /** Destination-chain execution prepay, in USD. No venue currently supplies an honest figure — see migration 050. */
  usdDestinationPrepayEst: string | null;
  /**
   * VEX's OWN integrator fee, in USD. Written on the row whose own on-chain
   * outcome decides whether the fee was actually collected — the `swap` leg for
   * an aggregator swap, the `bridge_fee` leg for a bridge — so
   * `SUM(usd_vex_fee_est) WHERE status='confirmed'` is honest revenue and never
   * double-counts. NULL where the fee is known in token units but has no
   * trustworthy USD price (recording nothing beats recording a guess).
   */
  usdVexFeeEst: string | null;
  /**
   * The Vex fee in TOKEN units (migration 050 Part 2) — exact, not an estimate.
   *
   * Read WITH `usdVexFeeEst`: an amount here plus a null USD means "fee
   * charged, USD unknown"; BOTH null means no Vex fee on this row — EXCEPT on
   * an `eventRole: 'bridge_fee'` row, where the fee IS the row and lives in
   * `amountInRaw`/`tokenInAddress`, and except on rows written before migration
   * 050, where null means "never recorded".
   *
   * Do NOT add this to `amountInRaw`: on the in-transaction venues the fee is
   * taken out of the input, so it is already a component of that amount.
   */
  vexFeeTokenAddress: string | null;
  vexFeeTokenSymbol: string | null;
  /** Decimals of `vexFeeTokenAddress` — `vexFeeAmountRaw` is unreadable without it. */
  vexFeeTokenDecimals: number | null;
  /** Atomic units as digits (TEXT column — a u64 fee exceeds `MAX_SAFE_INTEGER`). */
  vexFeeAmountRaw: string | null;
  /** Exact-decimal sibling of `vexFeeAmountRaw`. */
  vexFeeAmountHuman: string | null;
  usdSource: string | null;
  txHash: string | null;
  fromAddress: string | null;
  nonce: number | null;
  walletAddress: string;
  sessionId: string | null;
  routeProvenance: Record<string, unknown> | null;
  // ── Bridge columns (045) — NULL on swap rows ──
  fromChainId: number | null;
  fromChainSlug: string | null;
  toChainId: number | null;
  toChainSlug: string | null;
  chainFamily: BridgeChainFamily;
  providerOrderId: string | null;
  /** Only present on the logical `bridge_fill_expected` row (family-safe, provider-excluded route key). */
  normalizedRoute: string | null;
  /** Last provider-native status (e.g. Khalani "filled"/"refund_pending", Relay "success"). */
  providerStatus: string | null;
  /** Externally-observed provenance marker (e.g. "khalani_order_status"); NULL on Vex-signed rows. */
  evidenceSource: string | null;
  observedAt: string | null;
  lastAttemptedAt: string | null;
  submitAttemptedAt: string | null;
  /**
   * W5 staged-seam evidence (049): the blockhash `prepareVersionedTx`
   * persisted BEFORE signing (K2), together with `txHash`, the only currency
   * between prepare/persist/submit for a locally-staged Solana row. NULL on
   * every non-Solana row and on provider-observed Solana rows (never locally
   * staged). `agent_activity_solana_staged_has_evidence` (049) requires both
   * NOT NULL together whenever `chainFamily==='solana'` and
   * `submitAttemptedAt` is set.
   */
  recentBlockhash: string | null;
  /** Paired with `recentBlockhash` — see that field's doc. */
  lastValidBlockHeight: number | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  lastCheckedAt: string | null;
  /**
   * Consecutive INCONCLUSIVE verification attempts (migration 065). Resets to 0
   * on any successful observation, so it measures a STALL rather than age.
   * Feeds the DERIVED `stalled_verification` read-side flag and NOTHING else —
   * no threshold on it may ever write `status`.
   */
  verificationAttempts: number;
  /** Why the last attempt could not conclude, e.g. `no_safe_rpc`. NULL when nothing has failed yet. */
  lastVerificationReason: string | null;
  // ── Provenance (migration 067) ──────────────────────────────────────
  //
  // Read as `string | null`, written through the closed unions in
  // `./provenance-vocabulary.js`. Narrow on write, tolerate on read: pre-067
  // rows carry NULL and a future build may write a code this one has never
  // heard of, so a strict read type would break on the repo's own history.
  /** How the TERMINAL STATUS was established (`ConfirmationSource`). NULL while pending. */
  confirmationSource: string | null;
  /** How the EXECUTED AMOUNTS were established, or why they are absent (`SettlementSource`). */
  settlementSource: string | null;
  /** Why a still-PENDING row is pending (`PendingReason`). Cleared by every terminalizing CAS. */
  pendingReason: string | null;
  /** When `providerStatus` was observed — provider-to-provider ordering only. */
  providerStatusObservedAt: string | null;
  // ── The pending-fallback lane's own state (migration 068) ───────────
  /** When the current claim's lease expires. NULL when no claim is held. */
  evmClaimLeaseUntil: string | null;
  /** The current claim's GENERATION. Every post-RPC write must match it, or it writes nothing. */
  evmClaimToken: string | null;
  /**
   * When `verificationAttempts` last INCREMENTED — not when the row was last
   * checked. The two differ on purpose: the counter is throttled so it keeps
   * measuring ~10 minutes of stall whatever the polling rate is.
   */
  lastVerificationIncrementAt: string | null;
  /**
   * Start of a CONTINUOUS non-inclusion run, reset by any conclusive contrary
   * observation. Gates the `superseded_unproven` terminalization.
   */
  firstNonInclusionObservedAt: string | null;
  /** The decoder identity+version that last completed a decline on this row. */
  settlementDecodeVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Result of a CAS write — `applied:false` means the row was already terminal (or missing); `row` is always the CURRENT state either way. */
export interface CasResult {
  applied: boolean;
  row: AgentActivityEvent;
}
