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
import { buildUniswapQuoteSnapshot } from "./execution-binding.js";
import { canonicalWrapPairRefusal } from "../../../wrap-pair-refusal.js";
import { PREQUOTE_MAX_AGE_MS } from "../../../prequote/registry.js";
import {
  classifyMeasuredImpact,
  type QuoteEligibility,
} from "../../../quote-authority/eligibility.js";

/**
 * What this venue's impact measurement concluded. `null` is the STRUCTURAL
 * case, not a failure: `computeV2DirectPriceImpact` only prices a DIRECT V2
 * pair, so a V3 route, a multi-hop route, or a pair whose reserves could not be
 * read has no reference to size the trade against and never had one.
 */
type ImpactVerdict = QuoteEligibility | null;

/**
 * The agent-facing consequence, in the same breath as the route. The
 * unmeasured case says so OUT LOUD: a silent absence reads as "impact was
 * fine", which is exactly the reading a 15% ceiling exists to prevent.
 */
function impactNoteFor(verdict: ImpactVerdict): string {
  if (verdict === null) {
    return "Price impact was NOT measurable for this route: this venue derives impact only from a direct V2 pair's reserves,"
      + " and this route is not one. The quote is still executable; size the trade against a market read before committing to it.";
  }
  switch (verdict.kind) {
    case "executable":
      return verdict.adverse
        ? `This quote gives up ${(verdict.priceImpactFraction * 100).toFixed(2)}% of the input's reference value; it is still executable.`
        : `Measured price impact ${(verdict.priceImpactFraction * 100).toFixed(2)}%.`;
    case "excessive_impact":
      return `This route gives up ${(verdict.priceImpactFraction * 100).toFixed(2)}% of the input's reference value, at or above the ${(verdict.ceilingFraction * 100).toFixed(0)}% ceiling.`
        + " This quote does NOT authorize an execute. Trade a smaller size or use a deeper pair.";
    default:
      return "This venue's price-impact measurement did not produce a usable number, so the size of this trade cannot be checked"
        + " against a reference price. This quote does NOT authorize an execute. Request a fresh quote.";
  }
}

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
  // A native leg resolves to the deployment's wrapped-native address with
  // `isNative: true`, so this pair passes the same-token check above and would
  // otherwise reach the router, which treats both legs as one asset and finds
  // no route. Refused by name, with the tool that CAN build the conversion.
  const wrapPair = canonicalWrapPairRefusal(deployment.chainId, tokenIn, tokenOut, "uniswap__swap_quote");
  if (wrapPair) return { success: false, output: wrapPair };
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

  // What this quote AUTHORIZES, sealed here and nowhere else: the router input
  // after the fee, the fee disposition as disclosed, and the floor the execute
  // must write into its calldata. It rides the private `quoteAuthority` channel
  // to the prequote recorder - never `data`, which is model-visible context.
  // WHERE THIS VENUE MEASURES IMPACT, THE SHARED CEILING APPLIES. The
  // thresholds are not restated here: `classifyMeasuredImpact` owns them for
  // both venues, so the 15% refusal the agent's task shape promises is one
  // constant, not a per-venue habit. An unmeasured route stays executable and
  // says so - honest, never silent.
  const impact: ImpactVerdict = quoted.priceImpact === undefined
    ? null
    : classifyMeasuredImpact(quoted.priceImpact);
  const executable = impact === null || impact.kind === "executable";

  const snapshot = buildUniswapQuoteSnapshot({
    chainId: deployment.chainId,
    tokenIn,
    tokenOut,
    charge: feeCharge,
    quoted,
    // Display/audit copy of the row's own TTL. `swap_prequotes.expires_at`,
    // written by the recorder, is the AUTHORITY the claim reads; these two
    // differ by the recorder's own latency and nothing decides on this one.
    expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
  });

  const answer = ok({
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
    // The agent sees WHY, in the same object as the route. `impactMeasured`
    // distinguishes "measured and fine" from "never measured" - a bare
    // `executable: true` cannot carry that difference.
    eligibility: impact === null
      ? { kind: "executable" as const, executable: true, impactMeasured: false }
      : impact.kind === "executable"
        ? { kind: impact.kind, executable: true, impactMeasured: true, adverse: impact.adverse }
        : { kind: impact.kind, executable: false, impactMeasured: true },
    impactNote: impactNoteFor(impact),
  });

  return {
    ...answer,
    quoteAuthority: {
      // An ineligible verdict rides the SAME private channel Kyber's does, with
      // NO snapshot: the recorder writes a superseding non-`executable` row, so
      // an older priced quote for this identity stops being claimable at the
      // same instant and this one never becomes claimable at all. The identity
      // comes from the answer's own `data` through the venue extractor - the one
      // owner of what a uniswap quote's identity is.
      eligibilityKind: impact === null ? "executable" : impact.kind,
      routeSnapshot: executable ? { ...snapshot } : null,
    },
  };
}
