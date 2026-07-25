/**
 * Jupiter Prediction API — orderbook, orders, positions, and history types.
 */

import type { JupiterPredictionPagination } from "./base.js";
import type {
  JupiterPredictionEventMetadata,
  JupiterPredictionMarketMetadata,
} from "./events-markets.js";

// ── Orderbook ──────────────────────────────────────────────────────

export type JupiterPredictionOrderbookLevel = [priceCents: number, quantity: number];
export type JupiterPredictionOrderbookDollarLevel = [priceUsd: string, quantity: number];

export interface JupiterPredictionOrderbook {
  yes: JupiterPredictionOrderbookLevel[];
  no: JupiterPredictionOrderbookLevel[];
  yes_dollars: JupiterPredictionOrderbookDollarLevel[];
  no_dollars: JupiterPredictionOrderbookDollarLevel[];
}

export type JupiterPredictionOrderbookResponse = JupiterPredictionOrderbook | null;

export interface JupiterPredictionTradingStatusResponse {
  trading_active: boolean;
}

// ── Orders ─────────────────────────────────────────────────────────

export interface JupiterPredictionOrder {
  pubkey: string;
  owner: string;
  ownerPubkey: string;
  market: string;
  marketId: string;
  marketIdHash: string;
  eventId: string;
  position: string;
  status: "pending" | "filled" | "failed" | (string & {});
  isYes: boolean;
  isBuy: boolean;
  createdAt: number;
  updatedAt: number;
  /** Legacy floored whole-contract count (docs: "must not be used for accounting"). See `contractsMicro`/`contractsDecimal`. */
  contracts: string;
  /** Exact contract count, 1,000,000 = 1 contract (docs-documented sibling; not yet confirmed against a live order response). */
  contractsMicro?: string;
  /** Exact contract count as a decimal string (docs-documented sibling; see `contractsMicro`). */
  contractsDecimal?: string;
  maxFillPriceUsd: string;
  maxBuyPriceUsd: string | null;
  minSellPriceUsd: string | null;
  filledAt: number;
  /** Legacy floored whole-contract count. See `filledContractsMicro`/`filledContractsDecimal`. */
  filledContracts: string;
  filledContractsMicro?: string;
  filledContractsDecimal?: string;
  avgFillPriceUsd: string;
  settled: boolean;
  orderId: string;
  sizeUsd: string;
  eventMetadata: JupiterPredictionEventMetadata;
  marketMetadata: JupiterPredictionMarketMetadata;
  externalOrderId: string;
  bump: number;
}

export interface JupiterPredictionOrdersResponse {
  data: JupiterPredictionOrder[];
  pagination: JupiterPredictionPagination;
}

export type JupiterPredictionOrderResponse = JupiterPredictionOrder;

export interface JupiterPredictionOrderStatusHistoryItem {
  eventType: string;
  status: string;
  rawStatus: string;
  timestamp: number;
  signature: string;
  externalOrderId: string;
  orderId: string;
}

export interface JupiterPredictionOrderStatusResponse {
  orderPubkey: string;
  status: string;
  latestEventType: string;
  latestSignature: string;
  externalOrderId: string;
  orderId: string;
  history: JupiterPredictionOrderStatusHistoryItem[];
}

// ── Positions ──────────────────────────────────────────────────────

export interface JupiterPredictionPosition {
  pubkey: string;
  owner: string;
  ownerPubkey: string;
  market: string;
  marketId: string;
  marketIdHash: string;
  isYes: boolean;
  /** Legacy floored whole-contract count. See `contractsMicro`/`contractsDecimal`. */
  contracts: string;
  contractsMicro?: string;
  contractsDecimal?: string;
  totalCostUsd: string;
  sizeUsd: string;
  valueUsd: string | null;
  avgPriceUsd: string;
  markPriceUsd: string | null;
  sellPriceUsd: string | null;
  pnlUsd: string | null;
  pnlUsdPercent: number | null;
  pnlUsdAfterFees: string | null;
  pnlUsdAfterFeesPercent: number | null;
  openOrders: number;
  feesPaidUsd: string;
  realizedPnlUsd: number;
  claimed: boolean;
  claimedUsd: string;
  openedAt: number;
  updatedAt: number;
  claimableAt: number | null;
  payoutUsd: string;
  bump: number;
  eventId: string;
  eventMetadata: JupiterPredictionEventMetadata;
  marketMetadata: JupiterPredictionMarketMetadata;
  settlementDate: number | null;
  claimable: boolean;
}

export interface JupiterPredictionPositionsResponse {
  data: JupiterPredictionPosition[];
  pagination: JupiterPredictionPagination;
}

export type JupiterPredictionPositionResponse = JupiterPredictionPosition;

// ── History ────────────────────────────────────────────────────────

export interface JupiterPredictionHistoryEvent {
  id: number;
  eventType: string;
  signature: string;
  slot: string;
  timestamp: number;
  orderPubkey: string;
  positionPubkey: string;
  marketId: string;
  ownerPubkey: string;
  keeperPubkey: string;
  externalOrderId: string;
  orderId: string;
  isBuy: boolean;
  isYes: boolean;
  /** Legacy floored whole-contract count. See `contractsMicro`/`contractsDecimal`. */
  contracts: string;
  contractsMicro?: string;
  contractsDecimal?: string;
  filledContracts: string;
  filledContractsMicro?: string;
  filledContractsDecimal?: string;
  contractsSettled: string;
  contractsSettledMicro?: string;
  contractsSettledDecimal?: string;
  maxFillPriceUsd: string;
  avgFillPriceUsd: string;
  maxBuyPriceUsd: string | null;
  minSellPriceUsd: string | null;
  depositAmountUsd: string;
  totalCostUsd: string;
  feeUsd: string | null;
  grossProceedsUsd: string;
  netProceedsUsd: string;
  transferAmountToken: string | null;
  realizedPnl: string | null;
  realizedPnlBeforeFees: string | null;
  payoutAmountUsd: string;
  eventId: string;
  marketMetadata: JupiterPredictionMarketMetadata;
  eventMetadata: JupiterPredictionEventMetadata;
}

export interface JupiterPredictionHistoryResponse {
  data: JupiterPredictionHistoryEvent[];
  pagination: JupiterPredictionPagination;
}
