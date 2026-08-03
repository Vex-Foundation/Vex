/**
 * `pendle.pt.quote` — the read half of the PT surface: what a buy, sell or
 * redeem would deliver, previewed through Convert.
 *
 * INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): one leg must be a PT
 * on the resolved chain (out → buy, in → sell/redeem), so a quote with NO PT leg
 * can never record a generic swap identity that would authorize a same-legged
 * execute on the wrong instrument.
 *
 * Upstream error text NEVER reaches the model — only bounded, code-keyed detail.
 */

import { parseUnits } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { resolveMarketByPt, buildAssetMap } from "../../market-lookup.js";
import { resolveExitMarketByPt } from "../../matured-market-lookup.js";
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

export async function pendlePtQuote(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) {
    return fail("Missing required: chain, tokenIn, tokenOut, amountIn");
  }
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const receiver = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    const tokenOut = requireTokenAddress(tokenOutRaw);

    // INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): one leg must be an
    // active PT on the resolved chain (out → buy, in → sell/redeem). Mirrors the
    // execute side (which already fails without a market) and the YT quote's
    // guard: a quote with NO PT leg must never record a generic swap identity
    // that could authorize a same-legged execute on the wrong instrument.
    // R5b matrix. PT as OUT is a BUY, which is active-only. PT as IN is a sell
    // OR a redeem — and on a MATURED PT it can only be a redeem (Convert answers
    // `redeem-py`), which is an allowed exit, so the in-leg resolves the matured
    // catalogue too. `pt.sell`'s own execute stays active-only and refuses by
    // name, so a matured quote can only ever authorize the redeem.
    const marketByOut = await resolveMarketByPt(chainId, tokenOut);
    const exitByIn = await resolveExitMarketByPt(chainId, tokenIn.address);
    const marketByIn = exitByIn?.market ?? null;
    if (!marketByOut && !marketByIn) {
      return fail(await explainUnresolvedPendleMarket(chainId, chainEntry.slug, tokenIn.address, { action: "pt.buy", leg: "PT" }));
    }
    const ptIsOut = marketByOut !== null;
    const ptAddress = ptIsOut ? tokenOut : tokenIn.address;
    const market = ptIsOut ? marketByOut : marketByIn;

    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = resolvePendleSlippage("pendle.pt.quote", num(p, "slippageBps"));

    const client = getPendleClient();
    const response = await client.convert(chainId, {
      receiver,
      input: { token: tokenIn.address, amount: amountWei.toString() },
      outputToken: tokenOut,
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) {
      return fail("Pendle returned no route for this trade.");
    }
    const best = response.routes[0]!;
    const action = response.action === "redeem-py" ? "redeem" : "swap";
    const direction: "buy" | "sell" | "redeem" = action === "redeem" ? "redeem" : ptIsOut ? "buy" : "sell";

    const assetMap = await buildAssetMap(chainId);
    const outAmount = best.outputs[0]?.amount ?? "0";
    const outDecimals = assetMap.get(tokenOut.toLowerCase())?.decimals ?? null;

    // Echo EXACTLY the fields the recorder + extractPendleQuote validate. `chainId`
    // is the RESOLVED chain (the prequote identity binds it). `receiver` is the
    // resolved wallet (self); the redeem identity re-derives it identically.
    return ok({
      action,
      direction,
      chainId,
      tokenIn: { address: tokenIn.address, isNative: tokenIn.isNative },
      tokenOut: { address: tokenOut },
      pt: ptAddress,
      yt: market?.yt ?? null,
      market: market?.address ?? null,
      receiver,
      expiry: market?.expiry ?? null,
      liquidityUsd: market?.details.liquidity ?? null,
      priceImpact: best.data.priceImpact,
      feeUsdEstimate: best.data.feeUsd,
      amountIn: amountInRaw,
      amountOut: humanAmount(outAmount, outDecimals).toString(),
      aggregator: best.data.aggregatorType,
      slippageBps: num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS,
    });
  } catch (err) {
    return fail(`Pendle quote unavailable (${failureDetail("pendle.pt.quote", err)})`);
  }
}
