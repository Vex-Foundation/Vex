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
 */
export type AgentActivityKind = "swap" | "bridge" | "lend" | "prediction";

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
 * `bridge_deposit` is the Vex-signed origin leg; `bridge_fill_observed`/
 * `bridge_refund` are externally-observed (solver-signed) evidence rows.
 * `predict_sell` is a SINGLE-position close (`solana.predict.sell` ->
 * `DELETE /positions/{positionPubkey}`, one activity row); `predict_close`
 * is reserved for the `closeAll` bulk fan-out (`DELETE /positions`, N
 * independent activity rows, one per tx). Both cover Forecast(bisonfi)
 * orders identically — the provider distinction lives in how the row is
 * SUBMITTED (managed `/execute` vs the generic path), never in the role.
 */
export type AgentActivityEventRole =
  | "allowance_reset"
  | "allowance"
  | "swap"
  | "bridge_deposit"
  | "bridge_fill_expected"
  | "bridge_fill_observed"
  | "bridge_refund"
  | "lend_deposit"
  | "lend_withdraw"
  | "lend_borrow_operate"
  | "predict_buy"
  | "predict_sell"
  | "predict_claim"
  | "predict_close";

/** Chain family discriminator (045) — drives the nonce matrix + explorer-link resolution. */
export type BridgeChainFamily = "eip155" | "solana";

export type AgentActivityStatus = "pending" | "confirmed" | "definitively_failed";

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
  usdInEst: string | null;
  usdOutEst: string | null;
  usdFeeEst: string | null;
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
  createdAt: string;
  updatedAt: string;
}

/** Result of a CAS write — `applied:false` means the row was already terminal (or missing); `row` is always the CURRENT state either way. */
export interface CasResult {
  applied: boolean;
  row: AgentActivityEvent;
}
