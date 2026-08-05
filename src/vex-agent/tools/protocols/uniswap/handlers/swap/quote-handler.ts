/**
 * `uniswap.swap.quote` — read-only. Keyless on-chain quoting plus the embedded
 * SAFETY block the prequote extractor re-validates.
 */

import { parseUnits, formatUnits } from "viem";

import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { checkRouteFactories, probeFotSignal } from "@tools/uniswap/safety.js";

import type { ToolResult } from "../../../../types.js";
import { str, ok } from "../../../handler-helpers.js";
import { resolveUniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import { checkForbiddenFeeParams } from "./forbidden-params.js";
import { QUOTE_TOOL_ID } from "./protocol-id.js";
import { requireDeployment, routerFor } from "./deployment.js";
import { resolveUniswapToken } from "./token-resolution.js";
import { resolveUniswapSlippageBps } from "./slippage.js";
import { computeQuote } from "./route-quote.js";
import { checkOutputLiquidity, type UniswapSafetyBlock } from "./quote-safety.js";

export async function uniswapSwapQuote(p: Record<string, unknown>): Promise<ToolResult> {
  // Rejected HERE as well as on the execute, so a quote can never appear to
  // authorize a fee override the execute would refuse.
  const forbidden = checkForbiddenFeeParams(p);
  if (forbidden) return { success: false, output: forbidden };

  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return { success: false, output: "Missing required: chain, tokenIn, tokenOut, amountIn" };

  // Pure param policy first — cheapest check, and it must not depend on a chain
  // or a network round trip to tell the caller their tolerance is out of range.
  const slippage = resolveUniswapSlippageBps(QUOTE_TOOL_ID, p);
  if (!slippage.ok) return { success: false, output: slippage.reason };
  const slippageBps = slippage.bps;

  const deployment = requireDeployment(chain);
  const tokenIn = await resolveUniswapToken(deployment, tokenInRaw);
  const tokenOut = await resolveUniswapToken(deployment, tokenOutRaw);
  if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase() && tokenIn.isNative === tokenOut.isNative) {
    return { success: false, output: "tokenIn and tokenOut resolve to the same token." };
  }
  const amountIn = parseUnits(amountInRaw, tokenIn.decimals);

  // The SAME fee resolution the execute runs, in the SAME position (before the
  // quote): the route must be priced for the amount the router actually
  // receives, or the quote would advertise an output the execute cannot deliver.
  const feeCharge = await resolveUniswapFeeCharge({ chainId: deployment.chainId, tokenIn, amountInRaw: amountIn });
  const quoted = await computeQuote(deployment, tokenIn, tokenOut, feeCharge.swapAmountRaw, slippageBps);

  // Safety signals (LOCKED #5): factory allowlist + min-liquidity + FoT — never gate here.
  const client = getUniswapPublicClient(deployment);
  const [factory, liquidity, fotSuspected] = await Promise.all([
    checkRouteFactories(client, deployment, quoted.route),
    checkOutputLiquidity(deployment, tokenOut),
    tokenOut.isNative ? Promise.resolve(false) : probeFotSignal(client, deployment, tokenOut.address),
  ]);
  const safety: UniswapSafetyBlock = { factory, liquidity, fot: { suspected: fotSuspected } };

  return ok({
    chain: deployment.key,
    chainId: deployment.chainId,
    tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals, isNative: tokenIn.isNative },
    tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals, isNative: tokenOut.isNative },
    route: { version: quoted.route.version, path: quoted.route.path, fees: quoted.route.fees ?? null },
    // What the user is debited in total, and what the route was priced for —
    // they differ by the Vex fee, and stating only one of them is how an agent
    // ends up reporting a number the wallet never saw.
    amountIn: amountInRaw,
    amountInRaw: amountIn.toString(),
    swapAmountRaw: feeCharge.swapAmountRaw.toString(),
    swapAmount: formatUnits(feeCharge.swapAmountRaw, tokenIn.decimals),
    amountOut: formatUnits(quoted.amountOut, tokenOut.decimals),
    amountOutRaw: quoted.amountOut.toString(),
    minAmountOut: formatUnits(quoted.minAmountOut, tokenOut.decimals),
    minAmountOutRaw: quoted.minAmountOut.toString(),
    slippageBps,
    priceImpact: quoted.priceImpact ?? null,
    gasEstimate: quoted.route.gasEstimate?.toString() ?? null,
    router: routerFor(deployment, quoted.route),
    spender: tokenIn.isNative ? null : routerFor(deployment, quoted.route),
    safety,
    vexFee: feeCharge.disclosure,
  });
}
