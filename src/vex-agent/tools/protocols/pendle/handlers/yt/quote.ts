/**
 * `pendle.yt.quote` - the read half of the YT surface.
 *
 * INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): EXACTLY one leg must
 * be an active YT on the resolved chain (out → buy, in → sell). Without it, a
 * quote with two non-YT legs would still record a GENERIC swap identity that
 * could authorize the PT execute for the same legs - skipping the PT term-lock
 * warning path. Instrument confusion is a fund-safety hole, so the quote refuses
 * instead of degrading.
 */

import { parseUnits } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { resolveMarketByYt, buildAssetMap } from "../../market-lookup.js";
import {
  failureDetail,
  humanAmount,
  requirePendleChain,
  requireTokenAddress,
  resolveInputToken,
  resolvePendleSlippage,
} from "../shared.js";
import { YT_DECAY_WARNING } from "./decay-warning.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

export async function pendleYtQuote(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
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

    // INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): EXACTLY one leg
    // must be an active YT on the resolved chain (out → buy, in → sell). Without
    // this, a quote with two non-YT legs would still record a GENERIC swap
    // identity that could authorize the PT execute for the same legs - skipping
    // the PT term-lock warning path. Instrument confusion is a fund-safety hole,
    // so the quote refuses instead of degrading.
    const marketByOut = await resolveMarketByYt(chainId, tokenOut);
    const marketByIn = await resolveMarketByYt(chainId, tokenIn.address);
    if (marketByOut && marketByIn) {
      return fail("Both tokens are Pendle YTs - trade a YT against a payment token, one leg at a time.");
    }
    if (!marketByOut && !marketByIn) {
      return fail("Neither token is an active Pendle YT on this chain - find the YT via pendle__markets_discover, or use pendle__pt_quote for PT trades.");
    }
    const market = (marketByOut ?? marketByIn)!;
    const ytAddress = marketByOut ? tokenOut : tokenIn.address;
    const direction: "buy" | "sell" = marketByOut ? "buy" : "sell";

    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = resolvePendleSlippage("pendle.yt.quote", num(p, "slippageBps"));

    const client = getPendleClient();
    const response = await client.convert(chainId, {
      receiver,
      input: { token: tokenIn.address, amount: amountWei.toString() },
      outputToken: tokenOut,
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) {
      return fail("Pendle returned no route for this YT trade.");
    }
    const best = response.routes[0]!;

    const assetMap = await buildAssetMap(chainId);
    const outAmount = best.outputs[0]?.amount ?? "0";
    const outDecimals = assetMap.get(tokenOut.toLowerCase())?.decimals ?? null;

    // Echo the fields `extractPendleQuote` validates, with `instrument: "yt"` so
    // the recorder does NOT emit a PT-style term-lock (a YT is not locked - it
    // decays). `chainId` is the RESOLVED chain (the swap prequote identity binds
    // it). market/yt are guaranteed non-null by the instrument guard above; a YT
    // trade is ALWAYS a swap (never redeem-py), so `action` is fixed "swap".
    return ok({
      action: "swap",
      instrument: "yt",
      direction,
      chainId,
      tokenIn: { address: tokenIn.address, isNative: tokenIn.isNative },
      tokenOut: { address: tokenOut },
      pt: market.pt ?? null,
      yt: ytAddress,
      market: market.address,
      receiver,
      expiry: market.expiry ?? null,
      liquidityUsd: market.details.liquidity ?? null,
      priceImpact: best.data.priceImpact,
      feeUsdEstimate: best.data.feeUsd,
      amountIn: amountInRaw,
      amountOut: humanAmount(outAmount, outDecimals).toString(),
      aggregator: best.data.aggregatorType,
      slippageBps: num(p, "slippageBps") ?? VEX_DEFAULT_SLIPPAGE_BPS,
      decayWarning: YT_DECAY_WARNING,
    });
  } catch (err) {
    return fail(`Pendle YT quote unavailable (${failureDetail("pendle__yt_quote", err)})`);
  }
}
