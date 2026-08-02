/**
 * Trench Express bonding-curve on-chain readers.
 *
 * Wraps the verified `quote()` / `fakepool_stats()` / ERC-20 `decimals()` view
 * calls on the Diamond. `quote()` is DETERMINISTIC and FEE-INCLUSIVE (proven
 * live), so the value it returns is used directly as the trade expectation the
 * slippage floor is derived from. No provider number is trusted as a floor — the
 * floor is OUR own fresh read.
 */

import { formatEther, formatUnits, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { TRENCH_DIAMOND_ABI, TRENCH_ERC20_ABI } from "../abi.js";
import { TRENCH_DIAMOND_ADDRESS } from "../constants.js";

export type TrenchTradeSide = "buy" | "sell";

type CurvePublicClient = PublicClient<Transport, Chain>;

export interface CurveStats {
  readonly ethReserveWei: bigint;
  readonly tokenReserveRaw: bigint;
  readonly fakeEthWei: bigint;
  readonly priceRaw: bigint;
}

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;

/**
 * Anchored graduation threshold: ~7.5 ETH of real reserve, derived from the two
 * Diamond storage values seen in recon and re-verified live 2026-07-31
 * (`sqrt(ethMcapThreshold × fakeEth) − fakeEth = sqrt(40 × 2.5) − 2.5 = 7.5`).
 *
 * SCOPE — DO NOT WIDEN: this constant backs the QUOTE's one-line progress
 * DISCLOSURE only. It is deliberately NOT the denominator of the
 * `trench.tokens` curve-progress FILTER. Both of its inputs are Diamond
 * configuration that can change, and a stale denominator would silently select
 * the WRONG tokens for the agent. The filter instead reads the authoritative
 * threshold from Diamond storage at a pinned block on every call and fails
 * closed — see `./graduation-threshold.ts`. Never use this value as a filter
 * or gate input.
 */
export const TRENCH_GRADUATION_ETH_RESERVE_WEI = 7_500_000_000_000_000_000n; // 7.5 ETH

/** Curve progress toward graduation, 0-100, clamped. Quote disclosure only — see the constant's scope note. */
export function curveProgressPct(ethReserveWei: bigint): number {
  if (ethReserveWei <= 0n) return 0;
  if (ethReserveWei >= TRENCH_GRADUATION_ETH_RESERVE_WEI) return 100;
  return Number((ethReserveWei * 10_000n) / TRENCH_GRADUATION_ETH_RESERVE_WEI) / 100;
}

/**
 * Curve progress against an AUTHORITATIVE, same-block graduation reserve
 * (0-100, clamped). Used by the `trench.tokens` filter, where the denominator
 * is read live per call rather than assumed.
 */
export function curveProgressPctAgainst(ethReserveWei: bigint, graduationEthReserveWei: bigint): number {
  if (graduationEthReserveWei <= 0n) return 0;
  if (ethReserveWei <= 0n) return 0;
  if (ethReserveWei >= graduationEthReserveWei) return 100;
  return Number((ethReserveWei * 10_000n) / graduationEthReserveWei) / 100;
}

/**
 * Price impact of a trade against the curve, in signed percent (disclosure).
 *
 * Verified against the funded live probe (Rutherford confirmed the reserve
 * formula to the wei):
 *   spot price (ETH per token)      = (fakeEth + ethReserve) / tokenReserve
 *   execution price (ETH per token) = ethLeg / tokenLeg  (from our fresh quote)
 *   priceImpactPct = (execution − spot) / spot × 100
 * A BUY pays MORE ETH per token than spot (positive); a SELL receives LESS
 * (negative). `ethLeg`/`tokenLeg` are the two legs of the SAME quoted trade:
 * buy → (amountInWei, expectedTokensOut); sell → (expectedEthOut, amountInTokens).
 */
export function computePriceImpactPct(input: {
  readonly ethLegWei: bigint;
  readonly tokenLegRaw: bigint;
  readonly stats: CurveStats;
  readonly tokenDecimals: number;
}): number | null {
  const tokensHuman = Number(formatUnits(input.tokenLegRaw, input.tokenDecimals));
  const ethHuman = Number(formatEther(input.ethLegWei));
  const reserveEthHuman = Number(formatEther(input.stats.fakeEthWei + input.stats.ethReserveWei));
  const reserveTokHuman = Number(formatUnits(input.stats.tokenReserveRaw, input.tokenDecimals));
  if (tokensHuman <= 0 || reserveTokHuman <= 0) return null;
  const execPrice = ethHuman / tokensHuman;
  const spotPrice = reserveEthHuman / reserveTokHuman;
  if (spotPrice <= 0) return null;
  return ((execPrice - spotPrice) / spotPrice) * 100;
}

export async function readCurveStats(client: CurvePublicClient, token: Address): Promise<CurveStats> {
  const [ethReserve, tokenReserve, fakeEth, price] = await client.readContract({
    address: DIAMOND,
    abi: TRENCH_DIAMOND_ABI,
    functionName: "fakepool_stats",
    args: [token],
  });
  return { ethReserveWei: ethReserve, tokenReserveRaw: tokenReserve, fakeEthWei: fakeEth, priceRaw: price };
}

/**
 * Fresh deterministic curve quote. `buy` quotes tokens-out for an ETH input
 * (`ethOut=false`); `sell` quotes ETH-out for a token input (`ethOut=true`).
 */
export async function readCurveQuote(
  client: CurvePublicClient,
  input: { readonly token: Address; readonly side: TrenchTradeSide; readonly amountInRaw: bigint },
): Promise<bigint> {
  return client.readContract({
    address: DIAMOND,
    abi: TRENCH_DIAMOND_ABI,
    functionName: "quote",
    args: [input.token, input.amountInRaw, input.side === "sell"],
  });
}

export async function readTokenDecimals(client: CurvePublicClient, token: Address): Promise<number> {
  const decimals = await client.readContract({
    address: token,
    abi: TRENCH_ERC20_ABI,
    functionName: "decimals",
    args: [],
  });
  return Number(decimals);
}

export async function readTokenBalance(client: CurvePublicClient, token: Address, owner: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: TRENCH_ERC20_ABI, functionName: "balanceOf", args: [owner] });
}

export async function readTokenAllowance(
  client: CurvePublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return client.readContract({ address: token, abi: TRENCH_ERC20_ABI, functionName: "allowance", args: [owner, spender] });
}
