/**
 * `pendle.py.mint` — split ONE payment token into an EQUAL amount of PT and YT
 * in a single transaction (Convert action `mint-py`, `mintPyFromToken`).
 *
 * Fresh Convert re-fetch → `selectSafeRoute` fund-safety extractor (Router pin,
 * receiver == wallet, YT == quoted, exact spend, EXACT approval set) → exact
 * allowance to the pinned Router → broadcast. Approval- and prequote-gated
 * (kind `mint`). ACTIVE-ONLY (R5b matrix): minting after expiry is impossible.
 *
 * OPTION C (migration 053): a mint is 1 → 2, so BOTH out legs are staged on the
 * one `agent_activity` row and confirming it requires proving both.
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
import { selectSafeRoute, type PendleTxIntent } from "../../calldata.js";
import { broadcastUnconfirmedFailure } from "../broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "../signed-broadcast.js";
import {
  failureDetail,
  humanAmount,
  legInput,
  requirePendleChain,
  requireTokenAddress,
  resolveInputToken,
  resolvePendleSlippage,
  unsettledResult,
} from "../shared.js";
import { outputAmountFor } from "./route-outputs.js";

export async function executePendleMint(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), ptRaw = str(p, "pt"), tokenInRaw = str(p, "tokenIn"), amountInRaw = str(p, "amountIn");
  if (!chain || !ptRaw || !tokenInRaw || !amountInRaw) {
    return fail("Missing required: chain, pt, tokenIn, amountIn");
  }
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the mint is already on-chain.
  let txHash: Hex | undefined;
  const toolId = "pendle.py.mint";
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);
    const ptAddress = requireTokenAddress(ptRaw);
    /** A pre-signature refusal, recorded as a hashless `definitively_failed` row. */
    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: "yield_py", chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p, tokenOut: { tokenAddress: ptAddress },
        },
        failureCode,
        message,
      );
      return fail(message);
    };
    // ACTIVE-ONLY (R5b matrix): minting PT+YT after expiry is impossible.
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.address) {
      return refuse("route_not_found", await explainUnresolvedPendleMarket(chainId, chainSlug, ptAddress, { action: "py.mint", leg: "PT" }));
    }
    const ytAddress = getAddress(market.yt);
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = resolvePendleSlippage("pendle.py.mint", num(p, "slippageBps"));

    if (p.dryRun === true) {
      const response = await getPendleClient().convertMulti(chainId, {
        receiver: PENDLE_ROUTER, // placeholder — dry-run never signs
        inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
        outputs: [ptAddress, ytAddress],
        slippage: slippage.fraction,
      });
      const best = response?.routes[0];
      return ok({ dryRun: true, action: "mint", pt: ptAddress, yt: ytAddress, market: market.address, aggregator: best?.data.aggregatorType ?? null, priceImpact: best?.data.priceImpact ?? null, feeUsdEstimate: best?.data.feeUsd ?? null });
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

    const response = await getPendleClient().convertMulti(chainId, {
      receiver: wallet,
      inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
      outputs: [ptAddress, ytAddress],
      slippage: slippage.fraction,
    });
    if (!response) return refuse("route_not_found", "Pendle returned no mint route for these tokens.");
    if (response.action !== "mint-py") {
      return refuse("route_not_found", "Pendle did not return a mint route - for a plain PT buy use pendle__pt_buy.");
    }

    const intent: PendleTxIntent = {
      action: "py-mint",
      wallet,
      // The tolerance this route is held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      inputToken: tokenIn.address,
      inputAmountWei: amountWei,
      isNative: tokenIn.isNative,
      // mintPyFromToken carries the YT at arg 1 — bind it to the quoted market's YT.
      expectedYt: ytAddress,
      ptAddress: getAddress(ptAddress),
    };
    const route = selectSafeRoute(intent, response);

    // Approve EXACTLY the input token (native needs none; native is rejected
    // upstream anyway). Spender is the pinned Router.
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
    // Read BEFORE signing — the staged row's legs need their decimals.
    const assetMap = await buildAssetMap(chainId);
    const quotedPtOut = outputAmountFor(route.outputs, ptAddress);
    const quotedYtOut = outputAmountFor(route.outputs, ytAddress);
    const ptDec = assetMap.get(ptAddress.toLowerCase())?.decimals ?? null;
    const ytDec = assetMap.get(ytAddress.toLowerCase())?.decimals ?? null;

    // OPTION C (migration 053): a mint is 1 → 2, so BOTH out legs are staged on
    // the one row. `yield_py` populates exactly ONE side — the OUT side here —
    // and confirming it requires proving both of them.
    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: tokenIn.isNative ? amountWei : 0n },
      {
        toolId, eventRole: "yield_py", chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(tokenIn.address, assetMap.get(tokenIn.address.toLowerCase())?.symbol, tokenIn.decimals, amountWei.toString(), humanAmount(amountWei, tokenIn.decimals).toString()),
        tokenOut: legInput(ptAddress, assetMap.get(ptAddress.toLowerCase())?.symbol, ptDec, quotedPtOut, humanAmount(quotedPtOut, ptDec).toString()),
        tokenOut2: legInput(ytAddress, assetMap.get(ytAddress.toLowerCase())?.symbol, ytDec, quotedYtOut, humanAmount(quotedYtOut, ytDec).toString()),
        routeProvenance: { action: "mint-py", aggregator: route.data.aggregatorType, market: market.address },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    // The DECODED mint — both minted legs proven from the receipt's own logs.
    const ptOut = broadcast.executed.amountOutRaw ?? quotedPtOut;
    const ytOut = broadcast.executed.amountOut2Raw ?? quotedYtOut;

    logger.info("pendle.py.mint.executed", { market: market.address, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash, action: "mint", pt: ptAddress, yt: ytAddress, market: market.address,
        amountIn: amountInRaw,
        executedPtOut: humanAmount(ptOut, ptDec).toString(),
        executedYtOut: humanAmount(ytOut, ytDec).toString(),
        quotedPtOut: humanAmount(quotedPtOut, ptDec).toString(),
        quotedYtOut: humanAmount(quotedYtOut, ytDec).toString(),
      }, null, 2),
      data: {
        txHash,
        _executionId: broadcast.executionId,
        // NO `_tradeCapture` / `_tradeCaptureItems`: this tool's durable truth is
        // the `agent_activity` row written by `sendPendleRouterTx`, so the legacy
        // projection pipeline must not also run for it (`mutation-matrix.ts`,
        // `capture: "none"`).
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.py.mint", txHash, err);
    return fail(`Pendle mint failed (${failureDetail("pendle__py_mint", err)})`);
  }
}
