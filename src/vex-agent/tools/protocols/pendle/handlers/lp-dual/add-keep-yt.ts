/**
 * `pendle.lp.addKeepYt` — token → LP + kept YT, the two-output entry.
 *
 * Convert labels this plain `"add-liquidity"` — the SAME string a single-token
 * add returns — so the response's action field cannot tell them apart. What can,
 * and does, is the METHOD row in `calldata/bind-route.ts`: an `lp-add-keep-yt`
 * intent accepts only `addLiquiditySingleTokenKeepYt` calldata.
 *
 * BUY-SHAPED (R5b matrix): liquidity cannot be added after expiry, so this stays
 * ACTIVE-ONLY and names maturity as the refusal reason. Prequote-gated — see
 * `../lp-dual-prequote.ts`.
 */

import { getAddress, parseUnits, type Address, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { resolveMarketByAddress, buildAssetMap } from "../../market-lookup.js";
import { explainUnresolvedPendleMarket } from "../../matured-refusal.js";
import { selectSafeRoute, type PendleTxIntent } from "../../calldata.js";
import { broadcastUnconfirmedFailure } from "../broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "../signed-broadcast.js";
import { gatePendleLpDualExecute, recordPendleLpDualPrequote } from "../lp-dual-prequote.js";
import {
  failureDetail,
  humanAmount,
  legInput,
  legUsd,
  requirePendleChain,
  requireTokenAddress,
  resolveInputToken,
  resolvePendleSlippage,
  unsettledResult,
} from "../shared.js";
import { LP_EVENT_ROLE, ADD_KEEP_YT_TOOL_ID, approveRequired, quotedLeg } from "./dual-legs.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

export async function executePendleLpAddKeepYt(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const toolId = ADD_KEEP_YT_TOOL_ID;
  const chain = str(p, "chain"), marketRaw = str(p, "market"), tokenInRaw = str(p, "tokenIn"), amountInRaw = str(p, "amountIn");
  if (!chain || !marketRaw || !tokenInRaw || !amountInRaw) {
    return fail(`Missing required: chain, market, tokenIn, amountIn (${toolId})`);
  }
  let txHash: Hex | undefined;
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);
    const marketAddress = requireTokenAddress(marketRaw);

    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: LP_EVENT_ROLE, chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p, tokenOut: { tokenAddress: marketAddress },
        },
        failureCode,
        message,
      );
      return fail(message);
    };

    // BUY-SHAPED destination (R5b matrix): adding liquidity after expiry is
    // impossible, so the financial resolver stays ACTIVE-ONLY and the reason is
    // NAMED from the read-only classification lane. `lp.add`'s refusal is reused
    // deliberately — its recommended next step ("to exit an existing LP position
    // use pendle.lp.remove") is the right advice for this tool as well.
    const market = await resolveMarketByAddress(chainId, marketAddress);
    if (!market || !market.address) {
      return refuse(
        "route_not_found",
        await explainUnresolvedPendleMarket(chainId, chainSlug, marketAddress, { action: "lp.add", leg: "market" }),
      );
    }
    const marketAddr = getAddress(market.address);
    if (!market.yt) {
      return refuse("route_not_found", "This Pendle market reports no YT, so there is no yield token to keep - use pendle__lp_add.");
    }
    const ytAddress = getAddress(market.yt);
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    if (tokenIn.address === marketAddr || tokenIn.address === ytAddress) {
      return refuse("route_not_found", "tokenIn must be a plain payment token, not this market's own LP or YT.");
    }
    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = resolvePendleSlippage(toolId, num(p, "slippageBps"));

    const isDryRun = p.dryRun === true;
    const legs = {
      chainId,
      walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
      market: marketAddr,
      token: tokenIn.address,
      amount: amountInRaw,
    };

    if (!isDryRun) {
      const gate = await gatePendleLpDualExecute(toolId, "lp_add_keep_yt", sessionId, p, legs);
      if (gate.kind === "block") return refuse("route_not_found", gate.message);
    }

    let wallet: Address;
    let signer: ChainWallet | null = null;
    if (isDryRun) {
      wallet = getAddress(legs.walletAddress);
    } else {
      try {
        signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
      } catch (err) {
        return walletScopeErrorToResult(err);
      }
      if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
      wallet = getAddress(signer.address);
    }

    const response = await getPendleClient().convertMulti(chainId, {
      receiver: wallet,
      inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
      // Naming the YT alongside the LP is what asks Convert for the KEEP-YT
      // variant; the action string it returns is still plain "add-liquidity",
      // so the method bind below is what actually distinguishes them.
      outputs: [marketAddr, ytAddress],
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) {
      return refuse("route_not_found", "Pendle returned no keep-YT add-liquidity route for this market.");
    }
    if (response.action !== "add-liquidity") {
      return refuse("route_not_found", "Pendle did not return an add-liquidity route for this market.");
    }

    const intent: PendleTxIntent = {
      action: "lp-add-keep-yt",
      wallet,
      slippageBps: slippage.bps,
      inputToken: tokenIn.address,
      inputAmountWei: amountWei,
      isNative: false,
      // addLiquiditySingleTokenKeepYt carries the MARKET at arg 1; the YT leg is
      // the market's own and the floor resolves it by elimination.
      expectedMarket: marketAddr,
    };
    const route = selectSafeRoute(intent, response);

    const assetMap = await buildAssetMap(chainId);
    const quotedLpRaw = quotedLeg(route.outputs, marketAddr, "LP output");
    const quotedYtRaw = quotedLeg(route.outputs, ytAddress, "YT output");
    const lpDec = assetMap.get(marketAddr.toLowerCase())?.decimals ?? 18;
    const ytDec = assetMap.get(ytAddress.toLowerCase())?.decimals ?? null;
    const quotedLpHuman = humanAmount(quotedLpRaw, lpDec);
    const quotedYtHuman = humanAmount(quotedYtRaw, ytDec);
    const inHuman = humanAmount(amountWei, tokenIn.decimals);

    if (isDryRun) {
      await recordPendleLpDualPrequote(toolId, "lp_add_keep_yt", sessionId, p, legs, {
        secondLeg: ytAddress,
        aggregator: route.data.aggregatorType ?? null,
      });
      return ok({
        dryRun: true,
        action: "lp.addKeepYt",
        chainId,
        market: marketAddr,
        tokenIn: tokenIn.address,
        amountIn: amountInRaw,
        quotedLpOut: quotedLpHuman.toString(),
        ytOut: ytAddress,
        quotedYtOut: quotedYtHuman.toString(),
        expiry: market.expiry ?? null,
        priceImpact: route.data.priceImpact,
        feeUsdEstimate: route.data.feeUsd,
        aggregator: route.data.aggregatorType,
        slippageBps: num(p, "slippageBps") ?? VEX_DEFAULT_SLIPPAGE_BPS,
        note: "Nothing was broadcast. Call the same tool again with the EXACT same params (dryRun omitted or false) to execute.",
      });
    }

    if (signer === null) return fail(`${toolId}: no signing wallet resolved.`);

    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    await ensureErc20Balance(publicClient, {
      token: tokenIn.address,
      owner: wallet,
      required: amountWei,
      decimals: tokenIn.decimals,
    });
    await approveRequired(response, publicClient, walletClient);

    const inUsd = legUsd(assetMap, tokenIn.address, inHuman);

    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      // Never native: `resolveInputToken` refuses native input, so value is 0.
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: LP_EVENT_ROLE, chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(tokenIn.address, assetMap.get(tokenIn.address.toLowerCase())?.symbol, tokenIn.decimals, amountWei.toString(), inHuman.toString()),
        tokenOut: legInput(marketAddr, assetMap.get(marketAddr.toLowerCase())?.symbol, lpDec, quotedLpRaw, quotedLpHuman.toString()),
        // Option-C second leg — the kept YT, staged with the intent.
        tokenOut2: legInput(ytAddress, assetMap.get(ytAddress.toLowerCase())?.symbol, ytDec, quotedYtRaw, quotedYtHuman.toString()),
        ...(inUsd !== null ? { usdInEst: String(inUsd) } : {}),
        routeProvenance: { action: "lp-add-keep-yt", aggregator: route.data.aggregatorType, market: marketAddr, ytAddress },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    const executedLpRaw = broadcast.executed.amountOutRaw ?? quotedLpRaw;
    const executedYtRaw = broadcast.executed.amountOut2Raw ?? quotedYtRaw;
    const executedInRaw = broadcast.executed.amountInRaw ?? amountWei.toString();

    logger.info("pendle.lp.add_keep_yt.executed", { market: marketAddr, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash,
        action: "lp.addKeepYt",
        market: marketAddr,
        tokenIn: tokenIn.address,
        amountIn: amountInRaw,
        executedAmountIn: humanAmount(executedInRaw, tokenIn.decimals).toString(),
        executedLpOut: humanAmount(executedLpRaw, lpDec).toString(),
        quotedLpOut: quotedLpHuman.toString(),
        ytOut: ytAddress,
        executedYtOut: humanAmount(executedYtRaw, ytDec).toString(),
        quotedYtOut: quotedYtHuman.toString(),
      }, null, 2),
      data: { txHash, _executionId: broadcast.executionId },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure(toolId, txHash, err);
    return fail(`Pendle keep-YT add liquidity failed (${failureDetail(toolId, err)})`);
  }
}
