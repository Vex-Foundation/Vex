/**
 * Jupiter Lend Earn REST wire-first contracts.
 * Verified from official Jupiter docs and OpenAPI snippets on 2026-03-30.
 */

import type {
  SolanaInstructionWire,
  TransferResult,
} from "../../../shared/types.js";
import { JUPITER_LEND_API_BASE_URL, JUPITER_LEND_EARN_API_BASE_URL } from "../constants.js";

export { JUPITER_LEND_API_BASE_URL, JUPITER_LEND_EARN_API_BASE_URL };

export interface JupiterLendEarnAmountRequest {
  asset: string;
  signer: string;
  amount: string;
}

export interface JupiterLendEarnSharesRequest {
  asset: string;
  signer: string;
  shares: string;
}

export interface JupiterLendEarnPositionsParams {
  users: string[];
}

export interface JupiterLendEarnEarningsParams {
  user: string;
  positions: string[];
}

export interface JupiterLendEarnAssetInfo {
  address: string;
  /** Absent since the provider renamed this sub-object to camelCase (`chainId`) — kept optional, display-only. */
  chain_id?: string | number;
  name: string;
  symbol: string;
  decimals: number;
  /** Absent since the provider renamed this sub-object to camelCase (`logoUrl`) — kept optional, display-only. */
  logo_url?: string;
  price: string | number;
  /** Absent since the provider renamed this sub-object to camelCase (`coingeckoId`) — kept optional, display-only. */
  coingecko_id?: string;
}

export interface JupiterLendLiquiditySupplyData {
  modeWithInterest: boolean;
  supply: string;
  withdrawalLimit: string;
  lastUpdateTimestamp: string;
  expandPercent: string;
  expandDuration: string;
  baseWithdrawalLimit: string;
  withdrawableUntilLimit: string;
  withdrawable: string;
}

export interface JupiterLendEarnTokenInfo {
  id: string | number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  assetAddress: string;
  asset: JupiterLendEarnAssetInfo;
  totalAssets: string;
  totalSupply: string;
  convertToShares: string;
  convertToAssets: string;
  rewardsRate: string | number;
  supplyRate: string | number;
  totalRate: string | number;
  rebalanceDifference: string;
  liquiditySupplyData: JupiterLendLiquiditySupplyData;
}

export type JupiterLendEarnTokensResponse = JupiterLendEarnTokenInfo[];

export interface JupiterLendEarnUserPosition {
  token: JupiterLendEarnTokenInfo;
  ownerAddress: string;
  shares: string;
  underlyingAssets: string;
  underlyingBalance: string;
  allowance: string;
}

export type JupiterLendEarnPositionsResponse = JupiterLendEarnUserPosition[];

export interface JupiterLendEarnEarningsItem {
  address: string;
  ownerAddress: string;
  /** Numeric string live (confirmed `GET /earn/earnings`, LIVE-GATE FIX 2) — kept `string | number`, display-only. */
  earnings: string | number;
  slot: number;
}

/**
 * Official docs are inconsistent here:
 * - the example response is an array
 * - the pasted OpenAPI schema snippet shows a single object
 * Keep both until the upstream contract is clearer.
 */
export type JupiterLendEarnEarningsResponse =
  | JupiterLendEarnEarningsItem
  | JupiterLendEarnEarningsItem[];

export interface JupiterLendEarnTransactionResponse {
  transaction: string;
}

export interface JupiterLendEarnInstructionEnvelope {
  instructions: SolanaInstructionWire[];
}

/**
 * Official docs are inconsistent here:
 * - OpenAPI examples show a single Solana instruction object
 * - narrative examples reference an `.instructions` array
 * Keep both shapes and normalize in the service layer.
 */
export type JupiterLendEarnInstructionResponse =
  | SolanaInstructionWire
  | JupiterLendEarnInstructionEnvelope;

export interface JupiterLendEarnInstructionsResult {
  instructions: SolanaInstructionWire[];
  raw: JupiterLendEarnInstructionResponse;
}

export interface JupiterLendEarnEarningsResult {
  earnings: JupiterLendEarnEarningsItem[];
  raw: JupiterLendEarnEarningsResponse;
}

export interface JupiterLendEarnExecutionResult extends TransferResult {
  asset: string;
  signer: string;
  raw: JupiterLendEarnTransactionResponse;
}
