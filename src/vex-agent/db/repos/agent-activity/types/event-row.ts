/**
 * The `agent_activity` row shape itself: the domain event, its leg inputs, the
 * Vex fee charge, and the CAS write result.
 */

import type {
  AgentActivityEventRole,
  AgentActivityKind,
  BridgeChainFamily,
} from "./vocabulary.js";
import type { AgentActivityFailureCode, AgentActivityStatus } from "./status-and-failure.js";

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
