/**
 * `pendle.pt.buy` / `pendle.pt.sell` — the token↔PT AMM swap pair.
 *
 * Convert is RE-FETCHED here (the quote's route is never signed), then the
 * fund-safety extractor (`../../calldata.ts`, LOCKED G2#1) runs before signing:
 * Router pin, sender/value bind, EXACT approval-set bind, and calldata intent
 * bind (selector + decoded receiver == wallet + market/PT == quoted). Nothing is
 * signed unless every check passes.
 *
 * ACTIVE-ONLY (R5b matrix): a matured PT can be neither bought nor sold into the
 * AMM, and the refusal names `pendle.pt.redeem` as the tool that does work.
 */

import { getAddress, parseUnits, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { resolveMarketByPt, buildAssetMap } from "../../market-lookup.js";
import { explainUnresolvedPendleMarket } from "../../matured-refusal.js";
import { selectSafeRoute, type PendleAction, type PendleTxIntent } from "../../calldata.js";
import { broadcastUnconfirmedFailure } from "../broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "../signed-broadcast.js";
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

export async function executePendleSwap(
  p: Record<string, unknown>,
  side: "buy" | "sell",
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) {
    return fail("Missing required: chain, tokenIn, tokenOut, amountIn");
  }
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the trade is already on-chain.
  let txHash: Hex | undefined;
  const toolId = `pendle.pt.${side}`;
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    // A mutation without a session has nothing to attribute its durable row to.
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    const tokenOut = requireTokenAddress(tokenOutRaw);
    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = resolvePendleSlippage(toolId, num(p, "slippageBps"));

    // PT + canonical market — buy: PT is tokenOut; sell: PT is tokenIn.
    const ptAddress = side === "buy" ? tokenOut : tokenIn.address;

    /**
     * A refusal that happened before anything could be signed. It is recorded as
     * a hashless `definitively_failed` row so a refusal is as visible in Agent
     * Scan as a fill — "nothing happened" used to be indistinguishable from
     * "nothing was recorded".
     */
    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: "yield_pt", chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p,
          tokenIn: legInput(tokenIn.address, undefined, tokenIn.decimals, amountWei.toString(), humanAmount(amountWei, tokenIn.decimals).toString()),
          tokenOut: { tokenAddress: tokenOut },
        },
        failureCode,
        message,
      );
      return fail(message);
    };

    // ACTIVE-ONLY (R5b matrix): a matured PT can be neither bought nor sold into
    // the AMM. The reason is named from the read-only classification lane.
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.address) {
      return refuse("route_not_found", await explainUnresolvedPendleMarket(chainId, chainSlug, ptAddress, { action: side === "buy" ? "pt.buy" : "pt.sell", leg: "PT" }));
    }
    const expectedMarket = getAddress(market.address);

    if (p.dryRun === true) {
      const response = await getPendleClient().convert(chainId, {
        receiver: PENDLE_ROUTER, // placeholder — dry-run never signs
        input: { token: tokenIn.address, amount: amountWei.toString() },
        outputToken: tokenOut,
        slippage: slippage.fraction,
      });
      const best = response?.routes[0];
      return ok({ dryRun: true, side, market: expectedMarket, aggregator: best?.data.aggregatorType ?? null, priceImpact: best?.data.priceImpact ?? null, feeUsdEstimate: best?.data.feeUsd ?? null });
    }

    // Signer AFTER dryRun so a preview never decrypts a key.
    let signer: ChainWallet;
    try {
      signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
    const wallet = getAddress(signer.address);

    const response = await getPendleClient().convert(chainId, {
      receiver: wallet,
      input: { token: tokenIn.address, amount: amountWei.toString() },
      outputToken: tokenOut,
      slippage: slippage.fraction,
    });
    if (!response) return refuse("route_not_found", "Pendle returned no route for this trade.");
    if (response.action !== "swap") {
      return refuse("route_not_found", "Pendle did not return a swap route - a matured PT can only be redeemed (use pendle__pt_redeem).");
    }

    const intent: PendleTxIntent = {
      action: side as PendleAction,
      wallet,
      // The tolerance this route is held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      inputToken: tokenIn.address,
      inputAmountWei: amountWei,
      isNative: tokenIn.isNative,
      expectedMarket,
      ptAddress: getAddress(ptAddress),
      // Sell: bind the decoded TokenOutput.tokenOut to the quoted payment token.
      // (A buy's output PT is implied by the market — no output tuple to bind.)
      ...(side === "sell" ? { expectedOutputToken: tokenOut } : {}),
    };
    const route = selectSafeRoute(intent, response);

    // Read BEFORE signing: the durable row's legs must carry their decimals
    // (rules/90 — a raw amount without them is unreadable), and the staged
    // intent has to exist before a signature does.
    const assetMap = await buildAssetMap(chainId);
    const quotedOutRaw = route.outputs[0]?.amount ?? "0";
    const outDecimals = assetMap.get(tokenOut.toLowerCase())?.decimals ?? null;
    const inHuman = humanAmount(amountWei, tokenIn.decimals);
    const quotedOutHuman = humanAmount(quotedOutRaw, outDecimals);
    const inUsd = legUsd(assetMap, tokenIn.address, inHuman);
    const quotedOutUsd = legUsd(assetMap, tokenOut, quotedOutHuman);

    // Approve EXACTLY the required input token (native needs none). Spender is the
    // pinned Router (implicit in Convert's spender-less requiredApprovals).
    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    if (!tokenIn.isNative) {
      await ensureErc20Balance(publicClient, {
        token: tokenIn.address,
        owner: getAddress(signer.address),
        required: amountWei,
        decimals: tokenIn.decimals,
      });
      await ensurePendleAllowanceExact(publicClient, walletClient, tokenIn.address, PENDLE_ROUTER, amountWei);
    }

    const value = tokenIn.isNative ? amountWei : 0n;
    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value },
      {
        toolId: `pendle.pt.${side}`,
        eventRole: "yield_pt",
        chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(tokenIn.address, assetMap.get(tokenIn.address.toLowerCase())?.symbol, tokenIn.decimals, amountWei.toString(), inHuman.toString()),
        tokenOut: legInput(tokenOut, assetMap.get(tokenOut.toLowerCase())?.symbol, outDecimals, quotedOutRaw, quotedOutHuman.toString()),
        ...(inUsd !== null ? { usdInEst: String(inUsd) } : {}),
        ...(quotedOutUsd !== null ? { usdOutEst: String(quotedOutUsd) } : {}),
        routeProvenance: { aggregator: route.data.aggregatorType, market: expectedMarket },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") {
      return unsettledResult(`pendle.pt.${side}`, broadcast);
    }

    // The RESULT is the decoded fill, never the quote. `quotedAmountOut` stays
    // in the output beside it so the agent can see the slippage it actually got.
    const executedOutRaw = broadcast.executed.amountOutRaw ?? quotedOutRaw;
    const executedInRaw = broadcast.executed.amountInRaw ?? amountWei.toString();
    const executedOutHuman = humanAmount(executedOutRaw, outDecimals);
    const executedInHuman = humanAmount(executedInRaw, tokenIn.decimals);

    logger.info("pendle.pt.swap.executed", { side, market: expectedMarket, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash, side, market: expectedMarket, tokenIn: tokenIn.address, tokenOut,
        amountIn: amountInRaw,
        executedAmountIn: executedInHuman.toString(),
        executedAmountOut: executedOutHuman.toString(),
        quotedAmountOut: quotedOutHuman.toString(),
      }, null, 2),
      data: {
        txHash,
        _executionId: broadcast.executionId,
        // NO `_tradeCapture`: this tool's durable truth is the `agent_activity` row
        // written by `sendPendleRouterTx`, so the legacy projection pipeline must
        // not also run for it (`mutation-matrix.ts`, `capture: "none"`).
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure(`pendle.pt.${side}`, txHash, err);
    return fail(`Pendle ${side} failed (${failureDetail(`pendle.pt.${side}`, err)})`);
  }
}
