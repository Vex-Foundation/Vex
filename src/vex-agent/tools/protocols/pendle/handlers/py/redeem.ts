/**
 * `pendle.py.redeem` — burn an EQUAL PT+YT pair back to a token BEFORE expiry
 * (Convert action `redeem-py`, `redeemPyToToken`). Distinct from
 * `pendle.pt.redeem`, which redeems a MATURED PT (PT only, no YT).
 *
 * Same discipline as the mint: fresh Convert re-fetch → `selectSafeRoute`
 * fund-safety extractor → exact allowances to the pinned Router → broadcast.
 * Approval- and prequote-gated (kind `redeem_py`).
 *
 * OPTION C (migration 053): a pre-expiry redeem is 2 → 1, so BOTH burned legs
 * are staged on the one `agent_activity` row — the mirror of the mint.
 */

import { getAddress, parseUnits, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import type { PendleConvertResponse } from "@tools/pendle/types.js";

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

export async function executePendleRedeemPy(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), ptRaw = str(p, "pt"), amountInRaw = str(p, "amountIn");
  if (!chain || !ptRaw || !amountInRaw) return fail("Missing required: chain, pt, amountIn");
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the redeem is already on-chain.
  let txHash: Hex | undefined;
  const toolId = "pendle.py.redeem";
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
          sessionId, intentParams: p, tokenIn: { tokenAddress: ptAddress },
        },
        failureCode,
        message,
      );
      return fail(message);
    };
    // ACTIVE-ONLY (R5b matrix, Codex round-3 correction): the PT+YT pair
    // redemption is a PRE-EXPIRY action; after maturity the PT redeems alone
    // via pendle.pt.redeem, so the financial resolver never sees a matured
    // market here — the refusal is named from the read-only lane.
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.address) {
      return refuse("route_not_found", await explainUnresolvedPendleMarket(chainId, chainSlug, ptAddress, { action: "py.redeem", leg: "PT" }));
    }
    const ytAddress = getAddress(market.yt);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return refuse("route_not_found", "No output token — pass tokenOut (the market has no underlying to default to).");
    // PT decimals read ON-CHAIN (a PT is a plain ERC-20). PT and YT are minted 1:1
    // and share decimals, so the equal-leg burn amount uses the same wei.
    const ptToken = await resolveInputToken(chainEntry, ptRaw);
    const amountWei = parseUnits(amountInRaw, ptToken.decimals);
    const slippage = resolvePendleSlippage("pendle.py.redeem", num(p, "slippageBps"));

    if (p.dryRun === true) {
      return ok({ dryRun: true, action: "redeem", pt: ptAddress, yt: ytAddress, outputToken, market: market.address });
    }

    let signer: ChainWallet;
    try {
      signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
    const wallet = getAddress(signer.address);

    const response: PendleConvertResponse | null = await getPendleClient().convertMulti(chainId, {
      receiver: wallet,
      inputs: [
        { token: ptAddress, amount: amountWei.toString() },
        { token: ytAddress, amount: amountWei.toString() },
      ],
      outputs: [outputToken],
      slippage: slippage.fraction,
    });
    if (!response) return refuse("route_not_found", "Pendle returned no pre-expiry redeem route.");
    if (response.action !== "redeem-py") {
      return refuse("route_not_found", "Pendle did not return a pre-expiry redeem route — a MATURED PT uses pendle.pt.redeem.");
    }

    const intent: PendleTxIntent = {
      action: "py-redeem",
      wallet,
      // The tolerance this route is held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      inputToken: ptAddress,
      inputAmountWei: amountWei,
      isNative: false,
      expectedYt: ytAddress,
      ptAddress: getAddress(ptAddress),
      expectedOutputToken: outputToken,
    };
    const route = selectSafeRoute(intent, response);

    // Approve EXACTLY the required set (Convert asks YT + PT), each to the Router.
    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    for (const approval of response.requiredApprovals) {
      await ensurePendleAllowanceExact(publicClient, walletClient, getAddress(approval.token), PENDLE_ROUTER, BigInt(approval.amount));
    }
    const assetMap = await buildAssetMap(chainId);
    const quotedOutRaw = route.outputs[0]?.amount ?? "0";
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    const ptDec = assetMap.get(ptAddress.toLowerCase())?.decimals ?? ptToken.decimals;
    const ytDec = assetMap.get(ytAddress.toLowerCase())?.decimals ?? ptToken.decimals;

    // OPTION C (migration 053): a pre-expiry redeem is 2 → 1, so BOTH burned
    // legs are staged on the one row — the mirror image of the mint above.
    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: "yield_py", chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(ptAddress, assetMap.get(ptAddress.toLowerCase())?.symbol, ptDec, amountWei.toString(), humanAmount(amountWei, ptDec).toString()),
        tokenIn2: legInput(ytAddress, assetMap.get(ytAddress.toLowerCase())?.symbol, ytDec, amountWei.toString(), humanAmount(amountWei, ytDec).toString()),
        tokenOut: legInput(outputToken, assetMap.get(outputToken.toLowerCase())?.symbol, outDec, quotedOutRaw, humanAmount(quotedOutRaw, outDec).toString()),
        routeProvenance: { action: "redeem-py", aggregator: route.data.aggregatorType, market: market.address },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    // The DECODED redeem — both burns and the credit proven from the receipt.
    const outAmount = broadcast.executed.amountOutRaw ?? quotedOutRaw;

    logger.info("pendle.py.redeem.executed", { market: market.address, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash, action: "redeem", pt: ptAddress, yt: ytAddress, outputToken,
        amountIn: amountInRaw,
        executedAmountOut: humanAmount(outAmount, outDec).toString(),
        quotedAmountOut: humanAmount(quotedOutRaw, outDec).toString(),
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
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.py.redeem", txHash, err);
    return fail(`Pendle redeem failed (${failureDetail("pendle.py.redeem", err)})`);
  }
}
