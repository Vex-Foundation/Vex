/**
 * `pendle.py.quote` — the read half of the PY surface: what a mint (token →
 * PT+YT) or a PRE-EXPIRY redeem (PT+YT → token) would deliver.
 *
 * INSTRUMENT GUARD, fail-closed BEFORE any Convert call: the `pt` must be an
 * ACTIVE PT on the resolved chain (R5b matrix — both PY legs are pre-expiry
 * actions), so a quote can never record a PY identity that would authorize an
 * execute on the wrong instrument. Upstream error text NEVER reaches the model.
 */

import { getAddress, parseUnits } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { resolveMarketByPt, buildAssetMap } from "../../market-lookup.js";
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
import { outputAmountFor } from "./route-outputs.js";

export async function pendlePyQuote(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), direction = str(p, "direction"), ptRaw = str(p, "pt"), amountInRaw = str(p, "amountIn");
  if (!chain || !ptRaw || !amountInRaw) return fail("Missing required: chain, pt, amountIn");
  if (direction !== "mint" && direction !== "redeem") {
    return fail("direction must be 'mint' (token → PT+YT) or 'redeem' (pre-expiry PT+YT → token).");
  }
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const receiver = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
    const ptAddress = requireTokenAddress(ptRaw);

    // INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): the `pt` must be an
    // active PT on the resolved chain (mirrors the P3-fixed quotes). A quote with
    // no PT anchor must never record a PY identity that could authorize an execute
    // on the wrong instrument.
    // ACTIVE-ONLY (R5b matrix): both PY legs are pre-expiry actions.
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.address) {
      return fail(await explainUnresolvedPendleMarket(chainId, chainEntry.slug, ptAddress, { action: direction === "mint" ? "py.mint" : "py.redeem", leg: "PT" }));
    }
    const ytAddress = getAddress(market.yt);
    const slippage = resolvePendleSlippage("pendle.py.quote", num(p, "slippageBps"));
    const client = getPendleClient();
    const assetMap = await buildAssetMap(chainId);
    const slippageBpsEcho = num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;

    if (direction === "mint") {
      const tokenIn = await resolveInputToken(chainEntry, str(p, "tokenIn"));
      const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
      const response = await client.convertMulti(chainId, {
        receiver,
        inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
        outputs: [ptAddress, ytAddress],
        slippage: slippage.fraction,
      });
      if (!response || response.routes.length === 0) return fail("Pendle returned no mint route for these tokens.");
      if (response.action !== "mint-py") {
        return fail("Pendle did not return a mint route — for a plain PT buy use pendle.pt.buy, or a YT buy use pendle.yt.buy.");
      }
      const best = response.routes[0]!;
      const ptOut = outputAmountFor(best.outputs, ptAddress);
      const ytOut = outputAmountFor(best.outputs, ytAddress);
      const ptDec = assetMap.get(ptAddress.toLowerCase())?.decimals ?? null;
      const ytDec = assetMap.get(ytAddress.toLowerCase())?.decimals ?? null;
      // Echo EXACTLY the fields `extractPendlePyQuote` validates. `chainId` is the
      // RESOLVED chain; tokenIn = payment token, tokenOut = the PT anchor.
      return ok({
        action: "mint-py",
        direction: "mint",
        chainId,
        tokenIn: { address: tokenIn.address, isNative: tokenIn.isNative },
        tokenOut: { address: ptAddress },
        pt: ptAddress,
        yt: ytAddress,
        market: market.address,
        receiver,
        expiry: market.expiry ?? null,
        liquidityUsd: market.details.liquidity ?? null,
        priceImpact: best.data.priceImpact,
        feeUsdEstimate: best.data.feeUsd,
        amountIn: amountInRaw,
        ptOut: humanAmount(ptOut, ptDec).toString(),
        ytOut: humanAmount(ytOut, ytDec).toString(),
        aggregator: best.data.aggregatorType,
        slippageBps: slippageBpsEcho,
      });
    }

    // direction === "redeem" (pre-expiry PT+YT → token).
    const ptToken = await resolveInputToken(chainEntry, ptRaw);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return fail("No output token — pass tokenOut (the market has no underlying to default to).");
    const amountWei = parseUnits(amountInRaw, ptToken.decimals);
    const response = await client.convertMulti(chainId, {
      receiver,
      inputs: [
        { token: ptAddress, amount: amountWei.toString() },
        { token: ytAddress, amount: amountWei.toString() },
      ],
      outputs: [outputToken],
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) return fail("Pendle returned no pre-expiry redeem route.");
    if (response.action !== "redeem-py") {
      return fail("Pendle did not return a pre-expiry redeem route — a MATURED PT (PT only) uses pendle.pt.redeem.");
    }
    const best = response.routes[0]!;
    const outAmount = best.outputs[0]?.amount ?? "0";
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    return ok({
      action: "redeem-py",
      direction: "redeem",
      chainId,
      tokenIn: { address: ptAddress },
      tokenOut: { address: outputToken },
      pt: ptAddress,
      yt: ytAddress,
      market: market.address,
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
    return fail(`Pendle PY quote unavailable (${failureDetail("pendle.py.quote", err)})`);
  }
}
