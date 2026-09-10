/**
 * Keyless on-chain quoting - QuoterV2 + V2 `getAmountsOut`, best route - and
 * the slippage-derived `minAmountOut` the swap calldata is built against.
 *
 * The SAME function serves `uniswap.swap.quote` and `uniswap.swap.execute`, so
 * the pair cannot disagree about the route or the guard price.
 */

import type { Address } from "viem";
import { quoteBestRoute, applySlippage } from "@tools/uniswap/quote.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken, UniswapRoute } from "@tools/uniswap/types.js";

import { VexError, ErrorCodes } from "../../../../../../errors.js";
import { refreshUniswapRoute } from "@tools/uniswap/refresh-route.js";
import type { UniswapExecutionSnapshot } from "../../../quote-authority/uniswap.js";
import type { SwapPriceReference } from "@tools/evm-chains/swap-price-reference.js";

/** Reuse routing work only from a validated, unexpired prequote. The output is a fresh chain read. */
export async function refreshApprovedQuote(
  deployment: UniswapDeployment, tokenIn: UniswapToken, tokenOut: UniswapToken,
  amountIn: bigint, slippageBps: number, approved: UniswapExecutionSnapshot, wallet?: Address,
): Promise<QuotedRoute> {
  const hint = approved.routeHint;
  if (hint === undefined) {
    const fresh = await computeQuote(deployment, tokenIn, tokenOut, amountIn, slippageBps, false, wallet);
    return { ...fresh, ...(approved.priceReference === undefined ? {} : { priceReference: approved.priceReference }) };
  }
  if (hint.path[0]?.toLowerCase() !== tokenIn.address.toLowerCase()
    || hint.path[hint.path.length - 1]?.toLowerCase() !== tokenOut.address.toLowerCase()) {
    throw new VexError(ErrorCodes.SWAP_FAILED, "Approved route token identity changed; request a fresh uniswap__swap_quote.");
  }
  const route = await refreshUniswapRoute(getUniswapPublicClient(deployment), deployment, hint, amountIn);
  return { route, amountOut: route.amountOut, minAmountOut: BigInt(approved.approvedMinOutRaw), slippageBps,
    ...(approved.priceReference === undefined ? {} : { priceReference: approved.priceReference }) };
}

export interface QuotedRoute {
  priceReference?: SwapPriceReference;
  route: UniswapRoute;
  amountOut: bigint;
  minAmountOut: bigint;
  priceImpact?: number;
  slippageBps: number;
  selectionBasis?: string;
  v4Discovery?: import("@tools/uniswap/v4-quote.js").V4DiscoveryStats;
  v4FeeObservation?: {
    readonly approvedLpFee: number;
    readonly currentLpFee: number;
    readonly protection: string;
  };
}

export async function computeQuote(
  deployment: UniswapDeployment,
  tokenIn: UniswapToken,
  tokenOut: UniswapToken,
  amountIn: bigint,
  slippageBps: number,
  allowV4 = true,
  wallet?: Address,
): Promise<QuotedRoute> {
  const client = getUniswapPublicClient(deployment);
  const best = await quoteBestRoute(client, { deployment, tokenIn, tokenOut, amountIn, allowV4, slippageBps, ...(wallet ? { wallet } : {}) });
  if (!best) {
    // State which route families this request actually admitted.
    const probed = [
      deployment.v4 && allowV4 ? "discovered and cryptographically bound single-hop V4 pools" : null,
      deployment.v2 ? "V2 pairs" : null,
      deployment.v3 ? `V3 pools (fee tiers ${deployment.v3.feeTiers.join(", ")})` : null,
    ].filter((entry): entry is string => entry !== null);
    throw new VexError(
      ErrorCodes.KYBER_ROUTE_NOT_FOUND,
      `No Uniswap route found for ${tokenIn.symbol} → ${tokenOut.symbol} on ${deployment.name}.`,
      `This venue probed ${probed.length > 0 ? probed.join(" and ") : "no configured Uniswap deployment"} on ${deployment.name} and none of them price this pair.`
        + (deployment.v4 && allowV4
          ? " Pools absent from discovery or whose PoolKey cannot be bound are refused -"
          : " Uniswap v4 is not visible to this venue for this deployment or approved route -")
        + " quote the pair on KyberSwap, which aggregates other venues, before concluding it has no liquidity.",
    );
  }
  return {
    route: best.route,
    selectionBasis: best.selectionBasis,
    ...(best.v4Discovery === undefined ? {} : { v4Discovery: best.v4Discovery }),
    amountOut: best.route.amountOut,
    minAmountOut: applySlippage(best.route.amountOut, slippageBps),
    ...(best.priceImpact !== undefined ? { priceImpact: best.priceImpact } : {}),
    slippageBps,
  };
}
