/**
 * `pendle.lp.quote` — the read half of the single-token LP surface: what an add
 * (token → LP) or a remove (LP → token) would deliver.
 *
 * INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): the `market` must
 * resolve on the resolved chain, so a quote with no market anchor can never
 * record an LP identity that would authorize an execute on the wrong instrument.
 *
 * R5b matrix: a REMOVE quote resolves matured markets (removal is legal after
 * expiry and must quote for the position the user actually holds); an ADD quote
 * stays ACTIVE-ONLY and names maturity as the refusal reason.
 */

import { getAddress, parseUnits } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { resolveMarketByAddress, buildAssetMap } from "../../market-lookup.js";
import { resolveExitMarketByAddress } from "../../matured-market-lookup.js";
import { explainUnresolvedPendleMarket } from "../../matured-refusal.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  failureDetail,
  humanAmount,
  requirePendleChain,
  requireTokenAddress,
  resolveInputToken,
  resolvePendleSlippage,
} from "../shared.js";

export async function pendleLpQuote(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), direction = str(p, "direction"), marketRaw = str(p, "market"), amountInRaw = str(p, "amountIn");
  if (!chain || !marketRaw || !amountInRaw) return fail("Missing required: chain, market, amountIn");
  if (direction !== "add" && direction !== "remove") {
    return fail("direction must be 'add' (token → LP) or 'remove' (LP → token).");
  }
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const receiver = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
    const marketAddress = requireTokenAddress(marketRaw);

    // INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): the `market` must
    // resolve on the resolved chain. A quote with no market anchor must never
    // record an LP identity that could authorize an execute on the wrong
    // instrument.
    //
    // R5b matrix: a REMOVE quote resolves matured markets (removal is legal
    // after expiry and must quote for the position the user actually holds); an
    // ADD quote stays ACTIVE-ONLY and names maturity as the refusal reason.
    const market = direction === "remove"
      ? (await resolveExitMarketByAddress(chainId, marketAddress))?.market ?? null
      : await resolveMarketByAddress(chainId, marketAddress);
    if (!market || !market.address) {
      if (direction === "add") {
        return fail(await explainUnresolvedPendleMarket(chainId, chainEntry.slug, marketAddress, { action: "lp.add", leg: "market" }));
      }
      return fail("`market` is not a Pendle market on this chain — find it via pendle.yields.");
    }
    const marketAddr = getAddress(market.address);
    const slippage = resolvePendleSlippage("pendle.lp.quote", num(p, "slippageBps"));
    const client = getPendleClient();
    const assetMap = await buildAssetMap(chainId);
    const slippageBpsEcho = num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;

    if (direction === "add") {
      const tokenIn = await resolveInputToken(chainEntry, str(p, "tokenIn"));
      const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
      const response = await client.convertMulti(chainId, {
        receiver,
        inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
        outputs: [marketAddr],
        slippage: slippage.fraction,
      });
      if (!response || response.routes.length === 0) return fail("Pendle returned no add-liquidity route for these tokens.");
      if (response.action !== "add-liquidity") {
        return fail("Pendle did not return an add-liquidity route — for a plain PT buy use pendle.pt.buy.");
      }
      const best = response.routes[0]!;
      const lpOut = best.outputs.find((o) => o.token.toLowerCase() === marketAddr.toLowerCase())?.amount ?? "0";
      const lpDec = assetMap.get(marketAddr.toLowerCase())?.decimals ?? 18;
      // Echo EXACTLY the fields `extractPendleLpQuote` validates. `chainId` is the
      // RESOLVED chain; tokenIn = payment token, tokenOut = the LP (market) anchor.
      return ok({
        action: "add-liquidity",
        direction: "add",
        chainId,
        tokenIn: { address: tokenIn.address, isNative: tokenIn.isNative },
        tokenOut: { address: marketAddr },
        market: marketAddr,
        receiver,
        expiry: market.expiry ?? null,
        liquidityUsd: market.details.liquidity ?? null,
        priceImpact: best.data.priceImpact,
        feeUsdEstimate: best.data.feeUsd,
        amountIn: amountInRaw,
        amountOut: humanAmount(lpOut, lpDec).toString(),
        aggregator: best.data.aggregatorType,
        slippageBps: slippageBpsEcho,
      });
    }

    // direction === "remove" (LP → token). The LP token IS the market; read its
    // decimals on-chain like any ERC-20.
    const lpToken = await resolveInputToken(chainEntry, marketRaw);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return fail("No output token — pass tokenOut (the market has no underlying to default to).");
    const amountWei = parseUnits(amountInRaw, lpToken.decimals);
    const response = await client.convertMulti(chainId, {
      receiver,
      inputs: [{ token: marketAddr, amount: amountWei.toString() }],
      outputs: [outputToken],
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) return fail("Pendle returned no remove-liquidity route.");
    if (response.action !== "remove-liquidity") {
      return fail("Pendle did not return a remove-liquidity route for this market.");
    }
    const best = response.routes[0]!;
    const outAmount = best.outputs[0]?.amount ?? "0";
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    return ok({
      action: "remove-liquidity",
      direction: "remove",
      chainId,
      tokenIn: { address: marketAddr },
      tokenOut: { address: outputToken },
      market: marketAddr,
      receiver,
      expiry: market.expiry ?? null,
      liquidityUsd: market.details.liquidity ?? null,
      priceImpact: best.data.priceImpact,
      feeUsdEstimate: best.data.feeUsd,
      amountIn: amountInRaw,
      amountOut: humanAmount(outAmount, outDec).toString(),
      aggregator: best.data.aggregatorType,
      slippageBps: slippageBpsEcho,
    });
  } catch (err) {
    return fail(`Pendle LP quote unavailable (${failureDetail("pendle.lp.quote", err)})`);
  }
}
