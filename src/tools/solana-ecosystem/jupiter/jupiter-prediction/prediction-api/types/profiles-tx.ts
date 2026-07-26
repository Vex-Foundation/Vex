/**
 * Jupiter Prediction API — profile, PnL, leaderboards, trades, vault, and
 * transaction-meta types.
 *
 * W5 (migration 049): the monolithic sign-and-send execution-result types
 * (`JupiterPredictionExecutionResult`/`JupiterPredictionCloseAllExecutionItem`/
 * `JupiterPredictionCloseAllExecutionResult`) were removed — the staged
 * `agent_activity` write path (`vex-agent/tools/protocols/solana-jupiter/
 * predict-execute.ts`) now owns sign/persist/submit orchestration directly on
 * the K2 primitives; `service.ts` keeps only the request-only (no-sign)
 * transaction builders.
 */

// ── Profile ────────────────────────────────────────────────────────

export interface JupiterPredictionProfileResponse {
  ownerPubkey: string;
  realizedPnlUsd: string;
  totalVolumeUsd: string;
  predictionsCount: string;
  correctPredictions: string;
  wrongPredictions: string;
  /** Legacy floored whole-contract count. See `totalActiveContractsMicro`/`totalActiveContractsDecimal`. */
  totalActiveContracts: string;
  totalActiveContractsMicro?: string;
  totalActiveContractsDecimal?: string;
  totalPositionsValueUsd: string;
}

export interface JupiterPredictionPnlHistoryPoint {
  timestamp: number;
  realizedPnlUsd: string;
}

export interface JupiterPredictionPnlHistoryResponse {
  ownerPubkey: string;
  history: JupiterPredictionPnlHistoryPoint[];
}

// ── Trades ─────────────────────────────────────────────────────────

export interface JupiterPredictionTrade {
  /** Provider-prefixed string identity (e.g. "order-2782520"), not numeric. */
  id: string;
  ownerPubkey: string;
  marketId: string;
  message: string;
  timestamp: number;
  action: "buy" | "sell" | (string & {});
  side: "yes" | "no" | (string & {});
  eventTitle: string;
  marketTitle: string;
  amountUsd: string;
  priceUsd: string;
  /** Display-only. `null` when the event has no image — the provider's convention here. */
  eventImageUrl: string | null;
  eventId: string;
}

export interface JupiterPredictionTradesResponse {
  data: JupiterPredictionTrade[];
}

// ── Leaderboards ───────────────────────────────────────────────────

export interface JupiterPredictionLeaderboardSummaryPeriod {
  totalVolumeUsd: string;
  predictionsCount: number;
}

export interface JupiterPredictionLeaderboardEntry {
  ownerPubkey: string;
  realizedPnlUsd: string;
  totalVolumeUsd: string;
  predictionsCount: number;
  correctPredictions: number;
  wrongPredictions: number;
  winRatePct: string;
  period: string;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface JupiterPredictionLeaderboardsResponse {
  data: JupiterPredictionLeaderboardEntry[];
  summary: {
    all_time: JupiterPredictionLeaderboardSummaryPeriod;
    weekly: JupiterPredictionLeaderboardSummaryPeriod;
    monthly: JupiterPredictionLeaderboardSummaryPeriod;
  };
}

// ── Vault ──────────────────────────────────────────────────────────

export interface JupiterPredictionVaultInfoResponse {
  pubkey: string;
  data: Record<string, string>;
  vaultBalance: string;
}

// ── Transaction meta & execution ───────────────────────────────────

export interface JupiterPredictionTransactionMeta {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface JupiterPredictionTxMetaFields {
  txMeta?: JupiterPredictionTransactionMeta | null;
  blockhash?: string;
  lastValidBlockHeight?: number;
}

export interface JupiterPredictionCreateOrderDetails {
  orderPubkey: string | null;
  orderAtaPubkey: string | null;
  userPubkey: string;
  marketId: string;
  marketIdHash: string;
  positionPubkey: string;
  isBuy: boolean;
  isYes: boolean;
  /** Legacy floored whole-contract count. See `contractsMicro`/`contractsDecimal`. */
  contracts: string;
  contractsMicro?: string;
  contractsDecimal?: string;
  newContracts: string;
  newContractsMicro?: string;
  newContractsDecimal?: string;
  maxBuyPriceUsd: string | null;
  minSellPriceUsd: string | null;
  externalOrderId: string | null;
  orderCostUsd: string;
  newAvgPriceUsd: string;
  newSizeUsd: string;
  newPayoutUsd: string;
  estimatedProtocolFeeUsd: string;
  estimatedVenueFeeUsd: string;
  estimatedTotalFeeUsd: string;
}

/**
 * `execution` on a build response — the provider's managed-execution routing.
 * Present for BOTH keeper-filled (kalshi/polymarket) and Forecast (bisonfi)
 * orders; `executionModel` distinguishes them but does NOT gate `execution`
 * (corrected 2026-07-25, live-probed). `context` is opaque and MUST be passed
 * unchanged to the managed execute endpoint. `endpoint` is a provider-supplied
 * PATH — never used to build a URL directly; see `managed-execution.ts`.
 */
export interface JupiterPredictionExecutionContext {
  endpoint: string;
  context: Record<string, unknown>;
}

export interface JupiterPredictionCreateOrderResponse extends JupiterPredictionTxMetaFields {
  transaction: string | null;
  externalOrderId: string | null;
  order: JupiterPredictionCreateOrderDetails;
  /**
   * `"atomic_swap"` for a Jupiter Forecast (bisonfi) order; absent for a
   * keeper-filled order (kalshi/polymarket). PURELY DESCRIPTIVE — it does NOT
   * decide the submit lane. Both kinds return `execution` and both must go
   * through the managed execute endpoint; routing reads `execution`.
   */
  executionModel?: string | null;
  execution?: JupiterPredictionExecutionContext | null;
  /**
   * Signatures the provider is still WAITING FOR (see the schema's doc).
   * `[ourWallet]` when the provider has already filled its own slots — the
   * only shape Vex will co-sign, because it is what makes `signatures[0]` a
   * real transaction id before submit.
   */
  requiredSigners?: string[];
}

/** `POST /execute` response — see `JupiterPredictionExecuteRequest`. */
export interface JupiterPredictionExecuteResponse {
  status: "Success" | "Failed";
  signature: string | null;
  error: string | null;
  requestId?: string;
}

export interface JupiterPredictionClaimPositionDetails {
  positionPubkey: string;
  marketPubkey: string;
  userPubkey: string;
  ownerPubkey: string;
  isYes: boolean;
  /** Legacy floored whole-contract count. See `contractsMicro`/`contractsDecimal`. */
  contracts: string;
  contractsMicro?: string;
  contractsDecimal?: string;
  payoutAmountUsd: string;
}

export interface JupiterPredictionClaimPositionResponse extends JupiterPredictionTxMetaFields {
  transaction: string;
  position: JupiterPredictionClaimPositionDetails;
  /** UNVERIFIED for claim (no live position to probe) — read if present, never assumed absent. */
  execution?: JupiterPredictionExecutionContext | null;
  /** UNVERIFIED for claim — see `execution`. */
  requiredSigners?: string[];
}

export type JupiterPredictionCloseAllPositionsItem =
  | JupiterPredictionCreateOrderResponse
  | JupiterPredictionClaimPositionResponse;

export interface JupiterPredictionCloseAllPositionsResponse {
  data: JupiterPredictionCloseAllPositionsItem[];
}
