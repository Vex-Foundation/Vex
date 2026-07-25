/**
 * Transactions repo — public row + domain types for the unified feed.
 *
 * Re-exported from `transactions.ts` (the module gate); see that file's
 * module doc for the full three-half feed semantics, filters, and pagination
 * contract these types describe.
 */

import type { DecodedCursor } from "./transactions-cursor.js";

export type TransactionSource = "agent_activity" | "success" | "failure";

/**
 * One leg of a bridge execution (Agent Scan Phase 2, migration 045). A bridge
 * logical row (`event_role = 'bridge_fill_expected'`) carries `legs[]` — the
 * canonical expected-fill row INCLUDED, plus its allowance/deposit/observed-
 * fill/refund siblings — so the agent sees every leg's chain + hash + status
 * WITHOUT the feed emitting one row per leg. Each leg carries the on-chain
 * `txHash` (a public reference) and the chain identity needed to resolve an
 * explorer link; it deliberately does NOT carry a pre-built explorer URL — the
 * curated allowlist that validates explorer hosts lives in the desktop app
 * (`vex-app/src/shared/explorer-links.ts`, R14), and the consumer builds
 * `_explorerRefs` from `{chain, txHash}` exactly as it already does for the
 * top-level hash (`tools/internal/inspect-views/transactions.ts`). NEVER
 * truncated (OWNER RULE).
 */
export interface BridgeLegRow {
  eventIndex: number | null;
  /** 'allowance_reset' | 'allowance' | 'bridge_deposit' | 'bridge_fill_expected' | 'bridge_fill_observed' | 'bridge_refund'. */
  role: string | null;
  /** The leg's OWN execution chain id (provider-native; pair with `chainFamily`). */
  chainId: number | null;
  chainSlug: string | null;
  /** 'eip155' | 'solana'. */
  chainFamily: string | null;
  txHash: string | null;
  /** Raw lifecycle status of the leg's row ('pending' | 'confirmed' | 'definitively_failed'). */
  status: string | null;
  failureCode: string | null;
}

/**
 * One bounded, camelCase row in the unified feed. Failure rows carry no
 * economics. Every field below `toolId` is additive over the original
 * (Stage 9) shape — populated on the `agent_activity` half only, `undefined`/
 * `null` elsewhere, so an existing reader that only knew the original fields
 * is unaffected.
 */
export interface TransactionRow {
  source: TransactionSource;
  id: number;
  namespace: string;
  productType: string;
  tradeSide?: string | null;
  chain?: string | null;
  /** Convenience: symbol-or-address (prefer the granular fields below for anything precise). */
  inputToken?: string | null;
  /**
   * agent_activity only (FIX2-SPINE C20) — derived from raw + decimals per
   * `amountBasis`: `confirmed` → executed truth; `pending` → the requested
   * quote (never settlement); any other status → `null` (no display value).
   */
  inputAmount?: string | null;
  outputToken?: string | null;
  outputAmount?: string | null;
  /**
   * agent_activity only — which raw amount `inputAmount`/`outputAmount` was
   * derived from (FIX2-SPINE C20), or `null` when neither applies. Swaps/
   * lend/prediction use `executed` (decoder-proven), `requested` (a pending,
   * not-yet-broadcast-confirmed quote), or — W5/R5 correction — `estimated`
   * (a `confirmed` row whose settlement decoder did not prove executed
   * amounts; the quote is shown, explicitly marked as an estimate, never as
   * settlement truth). Bridges (BINDING Q2) use `executed` (an
   * independently-verified fill) or `estimated` (the quoted amount shown
   * explicitly as an estimate — a bridge never blanks a pending amount).
   */
  amountBasis?: "executed" | "requested" | "estimated" | null;
  valueUsd?: number | null;
  captureStatus?: string | null;
  /** agent_activity: 'pending' | 'confirmed' | 'definitively_failed'. failure half: always 'failed'. */
  status?: string | null;
  /** agent_activity only — the closed failure_code enum (plan §4.1). */
  failureCode?: string | null;
  /** agent_activity only — sanitized (redact()+capped) failure detail. */
  failureReason?: string | null;
  /** agent_activity only — numeric chain id (explorer-link derivation). */
  chainId?: number | null;
  /** agent_activity only — provider slug (e.g. "kyberswap" | "uniswap"). */
  protocol?: string | null;
  toolId?: string | null;
  durationMs?: number | null;
  /** agent_activity: its own protocol_execution_id. success: proj_activity.execution_id. failure: its own id. */
  protocolExecutionId?: number | null;
  /** agent_activity only — position within the execution's event group. */
  eventIndex?: number | null;
  /**
   * agent_activity only — 'allowance_reset' | 'allowance' | 'swap' |
   * 'bridge_*' | 'lend_deposit' | 'lend_withdraw' | 'lend_borrow_operate'
   * (migration 049) | 'predict_buy' | 'predict_sell' | 'predict_claim' |
   * 'predict_close' (migration 049).
   */
  eventRole?: string | null;
  /**
   * agent_activity only — REAL token mint/contract addresses (R5): the
   * deposit/withdraw mint for lend, the settlement mint for a prediction
   * buy/sell/claim. NEVER a position or market pubkey — that is not a token,
   * and vex-app's token-history view keys eligibility off these fields being
   * genuine mints (K8).
   */
  tokenInAddress?: string | null;
  tokenInSymbol?: string | null;
  tokenInDecimals?: number | null;
  tokenOutAddress?: string | null;
  tokenOutSymbol?: string | null;
  tokenOutDecimals?: number | null;
  /** agent_activity only — quote-time REQUESTED legs (may be present even on a pre-broadcast failure). */
  amountInHuman?: string | null;
  amountInRaw?: string | null;
  amountOutHuman?: string | null;
  amountOutRaw?: string | null;
  /** agent_activity only — receipt-derived EXECUTED legs (confirmed rows only). */
  executedAmountInHuman?: string | null;
  executedAmountInRaw?: string | null;
  executedAmountOutHuman?: string | null;
  executedAmountOutRaw?: string | null;
  usdInEst?: string | null;
  usdOutEst?: string | null;
  usdFeeEst?: string | null;
  usdSource?: string | null;
  /** agent_activity BRIDGE logical row only (migration 045) — route origin chain. */
  fromChainId?: number | null;
  fromChainSlug?: string | null;
  /** agent_activity BRIDGE logical row only — route destination chain. `chainId` (above) is this row's own chain (the destination, where the fill hash lives). */
  toChainId?: number | null;
  toChainSlug?: string | null;
  /**
   * agent_activity only — 'eip155' | 'solana' (this row's OWN chain family).
   * Bridge rows have always carried this (the leg's family); W5/R5 surfaces
   * it for any other kind too, once the write path populates it (a Solana
   * jupiter swap/lend/prediction row) — `null` where the write path never set
   * it (pre-W5 EVM swap rows).
   */
  chainFamily?: string | null;
  /** agent_activity BRIDGE logical row only — provider order id (Khalani orderId / Relay requestId). */
  providerOrderId?: string | null;
  /** agent_activity BRIDGE logical row only — last provider-native status (sweep feed; "tracking delayed" UX). */
  providerStatus?: string | null;
  /** agent_activity BRIDGE logical row only — every leg of the execution (B8); `null` on swaps. NEVER truncated (OWNER RULE). */
  legs?: BridgeLegRow[] | null;
  txHash: string | null;
  createdAt: string;
}

export interface GetTransactionsOptions {
  addresses: string[];
  sessionId: string | null;
  productType?: string;
  namespace?: string;
  txHash?: string;
  cursor?: DecodedCursor | null;
  limit: number;
}

export interface GetTransactionsResult {
  items: TransactionRow[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Always 'session' — failures are scoped to the current session only. */
  failuresScope: "session";
}
