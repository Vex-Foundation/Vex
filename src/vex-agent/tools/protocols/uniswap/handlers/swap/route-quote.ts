/**
 * Keyless on-chain quoting — QuoterV2 + V2 `getAmountsOut`, best route — and
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
}

export async function computeQuote(
  deployment: UniswapDeployment,
  tokenIn: UniswapToken,
  tokenOut: UniswapToken,
  amountIn: bigint,
  slippageBps: number,
): Promise<QuotedRoute> {
  const client = getUniswapPublicClient(deployment);
  const best = await quoteBestRoute(client, { deployment, tokenIn, tokenOut, amountIn });
  if (!best) {
    // What was ACTUALLY probed, never a guess about liquidity. This venue
    // quotes V2 pairs and V3 pools only (`quoteBestRoute`); a pair that exists
    // solely in a v4 pool, or on any other AMM on this chain, is invisible to
    // it for STRUCTURAL reasons, and saying "may have no liquidity" sends an
    // agent to check something that is not the cause.
    const probed = [
      deployment.v2 ? "V2 pairs" : null,
      deployment.v3 ? `V3 pools (fee tiers ${deployment.v3.feeTiers.join(", ")})` : null,
    ].filter((entry): entry is string => entry !== null);
    throw new VexError(
      ErrorCodes.KYBER_ROUTE_NOT_FOUND,
      `No Uniswap route found for ${tokenIn.symbol} → ${tokenOut.symbol} on ${deployment.name}.`,
      `This venue probed ${probed.length > 0 ? probed.join(" and ") : "no configured Uniswap deployment"} on ${deployment.name} and none of them price this pair.`
        + " A pool that exists only on Uniswap v4, or on another AMM, is not visible to this venue at all -"
        + " quote the pair on KyberSwap, which aggregates other venues, before concluding it has no liquidity.",
    );
  }
  return {
    route: best.route,
    amountOut: best.route.amountOut,
    minAmountOut: applySlippage(best.route.amountOut, slippageBps),
    ...(best.priceImpact !== undefined ? { priceImpact: best.priceImpact } : {}),
    slippageBps,
  };
}
