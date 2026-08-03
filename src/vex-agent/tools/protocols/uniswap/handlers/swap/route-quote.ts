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
    throw new VexError(
      ErrorCodes.KYBER_ROUTE_NOT_FOUND,
      `No Uniswap route found for ${tokenIn.symbol} → ${tokenOut.symbol} on ${deployment.name}.`,
      "The pair may have no liquidity on this chain.",
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
