/**
 * Keyless on-chain quoting - QuoterV2 + V2 `getAmountsOut`, best route - and
 * the slippage-derived `minAmountOut` the swap calldata is built against.
 *
 * The SAME function serves `uniswap.swap.quote` and `uniswap.swap.execute`, so
 * the pair cannot disagree about the route or the guard price.
 */

import { quoteBestRoute, applySlippage } from "@tools/uniswap/quote.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken, UniswapRoute } from "@tools/uniswap/types.js";

import { VexError, ErrorCodes } from "../../../../../../errors.js";

export interface QuotedRoute {
  route: UniswapRoute;
  amountOut: bigint;
  minAmountOut: bigint;
  priceImpact?: number;
  slippageBps: number;
  selectionBasis?: string;
  v4Discovery?: import("@tools/uniswap/v4-quote.js").V4DiscoveryStats;
}

export async function computeQuote(
  deployment: UniswapDeployment,
  tokenIn: UniswapToken,
  tokenOut: UniswapToken,
  amountIn: bigint,
  slippageBps: number,
  allowV4 = true,
): Promise<QuotedRoute> {
  const client = getUniswapPublicClient(deployment);
  const best = await quoteBestRoute(client, { deployment, tokenIn, tokenOut, amountIn, allowV4 });
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
