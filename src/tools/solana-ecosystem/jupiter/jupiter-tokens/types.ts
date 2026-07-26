/**
 * Jupiter Tokens API V2 wire-first contracts.
 * Verified from official Jupiter docs and API reference on 2026-03-30.
 */

import type { TokenMetadata } from "../../shared/types.js";

export const JUPITER_TOKENS_V2_BASE_URL = "https://api.jup.ag/tokens/v2";

export type JupiterTokenTag = "lst" | "verified" | "stocks";
export type JupiterTokenCategory = "toporganicscore" | "toptraded" | "toptrending";
export type JupiterTokenInterval = "5m" | "1h" | "6h" | "24h";
/**
 * Which stats window(s) a Vex-side caller wants projected. Not a Jupiter wire
 * value — `"all"` is Vex's own escape hatch to keep every interval block,
 * mirroring the projector's pre-existing default (see `projectors.ts`).
 */
export type JupiterTokenStatsInterval = JupiterTokenInterval | "all";

export interface JupiterTokenApy {
  /** Absent (empty `{}`) for tokens with no Jupiter Lend Earn market — most tokens. */
  jupEarn?: number;
  [key: string]: unknown;
}

export interface JupiterTokenSwapStats {
  priceChange?: number | null;
  holderChange?: number | null;
  liquidityChange?: number | null;
  volumeChange?: number | null;
  buyVolume?: number | null;
  sellVolume?: number | null;
  buyOrganicVolume?: number | null;
  sellOrganicVolume?: number | null;
  numBuys?: number | null;
  numSells?: number | null;
  numTraders?: number | null;
  numOrganicBuyers?: number | null;
  numNetBuyers?: number | null;
  [key: string]: unknown;
}

export interface JupiterTokenFirstPool {
  id: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface JupiterTokenAudit {
  isSus?: boolean | null;
  mintAuthorityDisabled?: boolean | null;
  freezeAuthorityDisabled?: boolean | null;
  topHoldersPercentage?: number | null;
  devBalancePercentage?: number | null;
  devMints?: number | null;
  [key: string]: unknown;
}

export interface JupiterMintInformation {
  id: string;
  name: string;
  symbol: string;
  icon?: string | null;
  decimals: number;
  tokenProgram?: string;
  createdAt?: string;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
  discord?: string | null;
  instagram?: string | null;
  tiktok?: string | null;
  otherUrl?: string | null;
  dev?: string | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  circSupply?: number | null;
  totalSupply?: number | null;
  launchpad?: string | null;
  partnerConfig?: string | null;
  graduatedPool?: string | null;
  graduatedAt?: string | null;
  holderCount?: number | null;
  fdv?: number | null;
  mcap?: number | null;
  usdPrice?: number | null;
  priceBlockId?: number | null;
  liquidity?: number | null;
  apy?: JupiterTokenApy | null;
  stats5m?: JupiterTokenSwapStats | null;
  stats1h?: JupiterTokenSwapStats | null;
  stats6h?: JupiterTokenSwapStats | null;
  stats24h?: JupiterTokenSwapStats | null;
  firstPool?: JupiterTokenFirstPool | null;
  audit?: JupiterTokenAudit | null;
  organicScore?: number;
  organicScoreLabel?: "high" | "medium" | "low" | (string & {});
  isVerified?: boolean | null;
  tags?: string[] | null;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface JupiterTokenSearchParams {
  query: string;
}

export interface JupiterTokenCategoryParams {
  category: JupiterTokenCategory;
  interval: JupiterTokenInterval;
  limit?: number;
}

export interface JupiterTokenContentSummaryLike {
  summaryFull: string | null;
  summaryShort: string | null;
  updatedAt: string;
  citations: string[];
  [key: string]: unknown;
}

export interface JupiterResolvedToken {
  token: JupiterMintInformation;
  metadata: TokenMetadata;
}

/**
 * Per-token risk signals lifted from Jupiter's `JupiterMintInformation.audit`
 * plus the verification flag. All fields are optional/nullable because Jupiter
 * may omit them and because resolution paths that do not hit the token API
 * (well-known list, local cache) have no audit data. This is informational
 * surfacing only — Stage 6a does not gate on these values.
 */
export interface JupiterTokenSafety {
  isSus?: boolean | null;
  mintAuthorityDisabled?: boolean | null;
  freezeAuthorityDisabled?: boolean | null;
  topHoldersPercentage?: number | null;
  isVerified?: boolean | null;
  organicScore?: number | null;
}

export function jupiterMintInformationToMetadata(token: JupiterMintInformation): TokenMetadata {
  return {
    chain: "solana",
    address: token.id,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    logoUri: token.icon ?? undefined,
  };
}

/**
 * Extract the per-token safety block from a fetched mint information record.
 * Builds the block with ONLY the fields Jupiter actually provided: each field
 * is included when its source value is not `undefined`/`null`, while meaningful
 * `false`/`0` signals (e.g. `freezeAuthorityDisabled: false`,
 * `topHoldersPercentage: 0`, `isVerified: false`) are preserved. Returns
 * `undefined` when no field survives, so absence is an absent block rather than
 * a bag of `undefined` values. Never throws on missing fields.
 */
export function jupiterMintInformationToSafety(
  token: JupiterMintInformation,
): JupiterTokenSafety | undefined {
  const audit = token.audit;
  const safety: JupiterTokenSafety = {};

  if (audit?.isSus != null) safety.isSus = audit.isSus;
  if (audit?.mintAuthorityDisabled != null) safety.mintAuthorityDisabled = audit.mintAuthorityDisabled;
  if (audit?.freezeAuthorityDisabled != null) safety.freezeAuthorityDisabled = audit.freezeAuthorityDisabled;
  if (audit?.topHoldersPercentage != null) safety.topHoldersPercentage = audit.topHoldersPercentage;
  if (token.isVerified != null) safety.isVerified = token.isVerified;
  if (token.organicScore != null) safety.organicScore = token.organicScore;

  return Object.keys(safety).length > 0 ? safety : undefined;
}
