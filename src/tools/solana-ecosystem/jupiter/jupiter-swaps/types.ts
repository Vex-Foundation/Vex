/**
 * Jupiter Swap API V2 wire-first contracts.
 * Verified from official Jupiter docs and API reference on 2026-03-30.
 */

import type {
  SolanaInstructionAccountMeta,
  SolanaInstructionWire,
  TokenMetadata,
} from "../../shared/types.js";
import type { JupiterTokenSafety } from "../jupiter-tokens/types.js";

export const JUPITER_SWAP_V2_BASE_URL = "https://api.jup.ag/swap/v2";
/** Different host path prefix than swap (`tx/v1`, not `swap/v2`), same `api.jup.ag` domain. */
export const JUPITER_TX_SUBMIT_BASE_URL = "https://api.jup.ag/tx/v1";

export type JupiterSwapRouter = "iris" | "jupiterz" | "dflow" | "okx" | (string & {});
export type JupiterSwapOrderMode = "ultra" | "manual" | (string & {});
export type JupiterSwapBuildMode = "fast";
export type JupiterSwapExactInMode = "ExactIn";
export type JupiterSwapBroadcastFeeType = "maxCap" | "exactFee";
/** `"medium"` (25th pct) / `"high"` (50th, default) / `"veryHigh"` (75th), or an explicit 0-10000 bps integer. */
export type JupiterSwapComputeUnitPricePercentile = "medium" | "high" | "veryHigh" | number;

export interface JupiterSwapRouteSwapInfo {
  ammKey: string;
  label: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
}

export interface JupiterSwapRoutePlanStep {
  swapInfo: JupiterSwapRouteSwapInfo;
  percent: number;
  bps: number;
  usdValue?: number;
}

export interface JupiterSwapPlatformFee {
  /** Absent at quote time on `/swap/v2/order`; present only on fee-bearing routes. */
  amount?: string;
  feeBps: number;
  feeMint: string;
}

export type JupiterSwapInstructionAccount = SolanaInstructionAccountMeta;
export type JupiterSwapInstruction = SolanaInstructionWire;

export interface JupiterSwapBuildBlockhashWithMetadata {
  blockhash: number[];
  lastValidBlockHeight: number;
}

export interface JupiterSwapOrderParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
  receiver?: string;
  swapMode?: JupiterSwapExactInMode;
  slippageBps?: number;
  referralAccount?: string;
  referralFee?: number;
  payer?: string;
  priorityFeeLamports?: number;
  jitoTipLamports?: number;
  broadcastFeeType?: JupiterSwapBroadcastFeeType;
  excludeRouters?: string | string[];
  excludeDexes?: string | string[];
}

export interface JupiterSwapOrderResponse {
  mode: JupiterSwapOrderMode;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  inUsdValue?: number;
  outUsdValue?: number;
  priceImpact?: number;
  swapUsdValue?: number;
  otherAmountThreshold: string;
  swapMode?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routePlan: JupiterSwapRoutePlanStep[];
  referralAccount?: string;
  feeMint?: string;
  feeBps?: number;
  platformFee?: JupiterSwapPlatformFee;
  signatureFeeLamports?: number;
  signatureFeePayer?: string | null;
  prioritizationFeeLamports?: number;
  prioritizationFeePayer?: string | null;
  rentFeeLamports?: number;
  rentFeePayer?: string | null;
  swapType?: "aggregator" | "rfq" | "aggregator+rfq" | "dflow" | "okx";
  router?: JupiterSwapRouter;
  transaction: string | null;
  lastValidBlockHeight?: string;
  gasless?: boolean;
  requestId: string;
  totalTime?: number;
  taker?: string | null;
  quoteId?: string;
  maker?: string;
  expireAt?: string;
  errorCode?: number;
  errorMessage?: string;
  error?: string;
}

export interface JupiterSwapBuildParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker: string;
  slippageBps?: number;
  mode?: JupiterSwapBuildMode;
  dexes?: string | string[];
  excludeDexes?: string | string[];
  platformFeeBps?: number;
  feeAccount?: string;
  maxAccounts?: number;
  payer?: string;
  wrapAndUnwrapSol?: boolean;
  destinationTokenAccount?: string;
  nativeDestinationAccount?: string;
  blockhashSlotsToExpiry?: number;
  /** SOL tip in lamports; adds a `tipInstruction` to the response for `/tx/v1/submit`. */
  tipAmount?: number;
  computeUnitPricePercentile?: JupiterSwapComputeUnitPricePercentile;
  /** Excludes DEXes incompatible with Jito bundles. */
  forJitoBundle?: boolean;
}

export interface JupiterSwapBuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode?: string;
  slippageBps?: number;
  /** Live `/build` responses carry this alongside `/order`'s; undocumented on the `/build` reference page (DOCS-GAP). */
  priceImpactPct?: string;
  routePlan: JupiterSwapRoutePlanStep[];
  computeBudgetInstructions: JupiterSwapInstruction[];
  setupInstructions: JupiterSwapInstruction[];
  swapInstruction: JupiterSwapInstruction;
  cleanupInstruction: JupiterSwapInstruction | null;
  otherInstructions: JupiterSwapInstruction[];
  /** Present only when `tipAmount` was requested; `null` otherwise. */
  tipInstruction?: JupiterSwapInstruction | null;
  addressesByLookupTableAddress?: Record<string, string[]> | null;
  blockhashWithMetadata?: JupiterSwapBuildBlockhashWithMetadata;
}

export interface JupiterSwapExecuteRequest {
  signedTransaction: string;
  requestId: string;
  lastValidBlockHeight?: string | number;
}

export interface JupiterSwapExecuteResponse {
  status: "Success" | "Failed";
  signature: string;
  code: number;
  inputAmountResult: string;
  outputAmountResult: string;
  error?: string;
}

/**
 * `POST /tx/v1/submit` — submits ANY signed Solana transaction (not tied to a
 * prior `/order`) through Jupiter's self-managed, tip-based landing pipeline.
 * Distinct from `/execute`: `/build` output has no `requestId` and cannot use
 * `/execute`, so a `/build`-assembled transaction must go through `/submit`.
 */
export interface JupiterSwapSubmitRequest {
  signedTransaction: string;
}

export interface JupiterSwapSubmitResponse {
  signature: string;
}

export interface JupiterSwapOrderOptions {
  taker?: string;
  receiver?: string;
  swapMode?: JupiterSwapExactInMode;
  slippageBps?: number;
  referralAccount?: string;
  referralFee?: number;
  payer?: string;
  priorityFeeLamports?: number;
  jitoTipLamports?: number;
  broadcastFeeType?: JupiterSwapBroadcastFeeType;
  excludeRouters?: string | string[];
  excludeDexes?: string | string[];
}

export interface JupiterSwapBuildOptions {
  taker: string;
  slippageBps?: number;
  mode?: JupiterSwapBuildMode;
  dexes?: string | string[];
  excludeDexes?: string | string[];
  platformFeeBps?: number;
  feeAccount?: string;
  maxAccounts?: number;
  payer?: string;
  wrapAndUnwrapSol?: boolean;
  destinationTokenAccount?: string;
  nativeDestinationAccount?: string;
  blockhashSlotsToExpiry?: number;
  tipAmount?: number;
  computeUnitPricePercentile?: JupiterSwapComputeUnitPricePercentile;
  forJitoBundle?: boolean;
}

/**
 * Per-token risk signals surfaced at quote time so the agent can see Solana
 * token risk before swapping. Optional/nullable because Jupiter may omit the
 * audit and because non-API resolution paths (well-known list, local cache)
 * have no audit data. Informational only in Stage 6a — no gating.
 */
export interface JupiterSwapTokenSafety {
  inputToken?: JupiterTokenSafety;
  outputToken?: JupiterTokenSafety;
}

export interface JupiterSwapQuoteSummary {
  inputToken: TokenMetadata;
  outputToken: TokenMetadata;
  safety?: JupiterSwapTokenSafety;
  inputAmount: string;
  outputAmount: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  otherAmountThreshold: string;
  priceImpact?: number;
  priceImpactPct: string;
  route: string[];
  routePlan: JupiterSwapRoutePlanStep[];
  provider: string;
  router?: JupiterSwapRouter;
  mode: JupiterSwapOrderMode;
  slippageBps?: number;
  feeBps?: number;
  feeMint?: string;
  platformFee?: JupiterSwapPlatformFee;
  gasless?: boolean;
  requestId: string;
  lastValidBlockHeight?: string;
}

export interface JupiterSwapBuildSummary {
  inputToken: TokenMetadata;
  outputToken: TokenMetadata;
  inputAmount: string;
  outputAmount: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  otherAmountThreshold: string;
  route: string[];
  routePlan: JupiterSwapRoutePlanStep[];
  slippageBps?: number;
  computeBudgetInstructionCount: number;
  setupInstructionCount: number;
  otherInstructionCount: number;
  hasCleanupInstruction: boolean;
  lookupTableCount: number;
  raw: JupiterSwapBuildResponse;
}

export interface JupiterSwapExecutionResult {
  signature: string;
  explorerUrl: string;
  inputAmount: string;
  outputAmount: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  inputToken: TokenMetadata;
  outputToken: TokenMetadata;
  router?: JupiterSwapRouter;
  mode: JupiterSwapOrderMode;
  feeBps?: number;
  feeMint?: string;
  platformFee?: JupiterSwapPlatformFee;
  gasless?: boolean;
  requestId: string;
  lastValidBlockHeight?: string;
  routePlan: JupiterSwapRoutePlanStep[];
  order: JupiterSwapOrderResponse;
  execute: JupiterSwapExecuteResponse;
}
