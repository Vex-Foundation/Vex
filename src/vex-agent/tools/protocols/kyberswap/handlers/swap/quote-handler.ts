/**
 * `kyberswap.swap.quote` — the read-only route probe. It signs nothing and
 * records nothing; its two jobs are seeding the prequote the execute is matched
 * against, and surfacing token danger the agent would otherwise not see.
 */

import { getKyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import { resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";
import { resolveTokenMetadataStrict, requireFeature, type ResolvedKyberTokenMetadata } from "@tools/kyberswap/helpers.js";
import { annotateNativeSymbol } from "@tools/evm-chains/native-currency.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import { parseUnits } from "viem";
import { formatRouteSummary } from "../../helpers.js";
import type { ProtocolHandler } from "../../../types.js";
import { str, ok, fail } from "../../../handler-helpers.js";
import { kyberFailureMessage } from "./error-output.js";
import { revealOnEligibleFailure } from "./reveal-messaging.js";
import { resolveKyberSlippageBps } from "./slippage.js";
import { resolveQuoteSafetyLeg, type QuoteSafety, type QuoteSafetyLeg } from "./quote-safety.js";
import { VEX_INTEGRATOR_FEE_ROUTE_PARAMS, type KyberGetRouteResponse } from "./route-request.js";

export const quoteHandler: ProtocolHandler = async (p, context) => {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

  // Rejected HERE, not only at the execute: this quote seeds the prequote
  // the execute is matched against, and `slippageBps` is part of that
  // identity — so a tolerance the execute would refuse must never produce a
  // quote that appears to authorize it.
  const quoteSlippage = resolveKyberSlippageBps("kyberswap.swap.quote", p);
  if (!quoteSlippage.ok) return fail(quoteSlippage.reason);

  let slug: KyberChainSlug;
  let chainId: number;
  try {
    slug = resolveChainSlug(chain);
    requireFeature(slug, "aggregator");
    chainId = slugToChainId(slug);
  } catch (err) {
    const revealSuffix = revealOnEligibleFailure(err, context.sessionId, false);
    return fail(`kyberswap.swap.quote failed: ${kyberFailureMessage("kyberswap.swap.quote", err)}.${revealSuffix}`);
  }

  let tokenIn: ResolvedKyberTokenMetadata;
  let tokenOut: ResolvedKyberTokenMetadata;
  try {
    // Strict: address-only (+ native sentinel/keyword) — symbols are NOT
    // resolved via Kyber's DEX search here. A symbol like "USDC" can match the
    // wrong contract (e.g. axlUSDC) and seed a prequote for the wrong token, so
    // the quote resolution is symmetric with execute (resolveTokenMetadataStrict)
    // and EVM symbols must be resolved with token_find first.
    tokenIn = await resolveTokenMetadataStrict(tokenInRaw, chainId);
    tokenOut = await resolveTokenMetadataStrict(tokenOutRaw, chainId);
  } catch (err) {
    return fail(`kyberswap.swap.quote failed: ${kyberFailureMessage("kyberswap.swap.quote", err)}`);
  }
  // Agent-facing labels only. A native leg's `symbol` is the chain-agnostic
  // `NATIVE` sentinel, which tells the agent nothing about what it is trading;
  // these annotate it with the chain's real ticker (`NATIVE (ETH)`), degrading
  // to the bare sentinel when the chain cannot be resolved. `tokenIn.symbol`
  // itself stays canonical — it is what gets persisted and matched on.
  const tokenInLabel = annotateNativeSymbol(tokenIn.symbol, chainId);
  const tokenOutLabel = annotateNativeSymbol(tokenOut.symbol, chainId);
  const amountIn = parseUnits(amountInRaw, tokenIn.decimals).toString();

  let response: KyberGetRouteResponse;
  let safetyIn: QuoteSafetyLeg;
  let safetyOut: QuoteSafetyLeg;
  try {
    [response, safetyIn, safetyOut] = await Promise.all([
      getKyberAggregatorClient().getRoute(slug, {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn,
        ...VEX_INTEGRATOR_FEE_ROUTE_PARAMS,
      }),
      resolveQuoteSafetyLeg(chainId, tokenIn),
      resolveQuoteSafetyLeg(chainId, tokenOut),
    ]);
  } catch (err) {
    const revealSuffix = revealOnEligibleFailure(err, context.sessionId, true);
    return fail(`kyberswap.swap.quote failed: ${kyberFailureMessage("kyberswap.swap.quote", err)}.${revealSuffix}`);
  }
  const safety: QuoteSafety = { tokenIn: safetyIn, tokenOut: safetyOut };
  const route = formatRouteSummary(response.data.routeSummary);

  // Output-polish (plan §4.2): compact human summary FIRST, machine fields
  // after — as one JSON key ordering, not a free-text prefix, so `output`
  // stays parseable (every tool in this codebase returns JSON via `ok()`,
  // and downstream tests/consumers rely on `JSON.parse(result.output)`).
  const summary =
    `Quote: ${amountInRaw} ${tokenInLabel} → ~${route.amountOut} ${tokenOutLabel} `
    + `(~$${route.amountOutUsd} est.) on ${slug}. Gas ~$${route.gasUsd} est.`
    // On an L2 the L1 data fee can rival or exceed execution gas — quoting
    // only `gasUsd` understated the real cost of the trade.
    + (route.l1FeeUsd !== null ? ` L1 data fee ~$${route.l1FeeUsd} est.` : "")
    + (route.priceImpact !== null ? ` Price impact ${(route.priceImpact * 100).toFixed(2)}%.` : "");

  return ok({
    summary,
    chain: slug, chainId,
    tokenIn: { address: tokenIn.address, symbol: tokenInLabel, decimals: tokenIn.decimals },
    tokenOut: { address: tokenOut.address, symbol: tokenOutLabel, decimals: tokenOut.decimals },
    routeSummary: route,
    routerAddress: response.data.routerAddress,
    safety,
  });
};
