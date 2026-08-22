/**
 * `pendle.lp.remove` — burn the LP token back to ONE output token (Convert
 * action `remove-liquidity`, `removeLiquiditySingleToken`).
 *
 * Same discipline as the add: fresh Convert re-fetch → `selectSafeRoute`
 * fund-safety extractor (the approval binds the LP/market token) → exact
 * allowance to the pinned Router → broadcast. Approval- and prequote-gated
 * (kind `lp_remove`).
 *
 * EXIT PATH (R5b): removal is legal after expiry — Pendle documents it as
 * callable regardless of the market's expiry — so the matured catalogue is in
 * scope. FULL-EXIT detection is fail-safe: an unreadable LP balance is NOT a
 * proven full exit, so the position stays open.
 */

import { getAddress, parseUnits, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER, PENDLE_ERC20_ABI } from "@tools/pendle/constants.js";
import { getPendleEvmClients, getPendlePublicClient } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { buildAssetMap } from "../../market-lookup.js";
import { resolveExitMarketByAddress } from "../../matured-market-lookup.js";
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

export async function executePendleLpRemove(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), marketRaw = str(p, "market"), amountInRaw = str(p, "amountIn");
  if (!chain || !marketRaw || !amountInRaw) return fail("Missing required: chain, market, amountIn");
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the withdrawal is already on-chain.
  let txHash: Hex | undefined;
  const toolId = "pendle.lp.remove";
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);
    const marketAddress = requireTokenAddress(marketRaw);
    /** A pre-signature refusal, recorded as a hashless `definitively_failed` row. */
    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: "yield_lp", chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p, tokenIn: { tokenAddress: marketAddress },
        },
        failureCode,
        message,
      );
      return fail(message);
    };
    // EXIT PATH (R5b): removal is legal after expiry — Pendle documents remove
    // as "callable regardless of the market's expiry" — so this resolves the
    // matured catalogue too. An inactive row is only believed on a parseable,
    // past expiry; anything else is refused by name inside the resolver.
    const resolved = await resolveExitMarketByAddress(chainId, marketAddress);
    if (!resolved || !resolved.market.address) {
      return refuse("route_not_found", "No Pendle market at this address - check pendle__markets_discover (includeMatured:true covers expired markets).");
    }
    const market = resolved.market;
    const marketAddr = getAddress(market.address);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return refuse("route_not_found", "No output token — pass tokenOut (the market has no underlying to default to).");
    // LP token decimals read ON-CHAIN (the market IS a plain ERC-20 LP token).
    const lpToken = await resolveInputToken(chainEntry, marketRaw);
    const amountWei = parseUnits(amountInRaw, lpToken.decimals);
    const slippage = resolvePendleSlippage("pendle.lp.remove", num(p, "slippageBps"));

    if (p.dryRun === true) {
      return ok({ dryRun: true, action: "remove", market: marketAddr, tokenOut: outputToken });
    }

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
      inputs: [{ token: marketAddr, amount: amountWei.toString() }],
      outputs: [outputToken],
      slippage: slippage.fraction,
    });
    if (!response) return refuse("route_not_found", "Pendle returned no remove-liquidity route.");
    if (response.action !== "remove-liquidity") {
      return refuse("route_not_found", "Pendle did not return a remove-liquidity route for this market.");
    }

    const intent: PendleTxIntent = {
      action: "lp-remove",
      wallet,
      // The tolerance this route is held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      // The "input" being spent is the LP (market) token — approvals bind to it.
      inputToken: marketAddr,
      inputAmountWei: amountWei,
      isNative: false,
      expectedMarket: marketAddr,
      expectedOutputToken: outputToken,
    };
    const route = selectSafeRoute(intent, response);

    // Approve EXACTLY the LP/market token (Convert asks for it), to the Router.
    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    for (const approval of response.requiredApprovals) {
      await ensurePendleAllowanceExact(publicClient, walletClient, getAddress(approval.token), PENDLE_ROUTER, BigInt(approval.amount));
    }

    // Full-exit detection (Codex): close the LP position ONLY when the removed LP
    // amount covers the wallet's ENTIRE LP balance. A partial remove reduces the
    // position but leaves it OPEN. Fail-safe: an unreadable balance → NOT a proven
    // full exit → leave open.
    let fullExit = false;
    try {
      const lpBalance = (await getPendlePublicClient(chainId).readContract({
        address: marketAddr,
        abi: PENDLE_ERC20_ABI,
        functionName: "balanceOf",
        args: [wallet],
      })) as bigint;
      fullExit = amountWei >= lpBalance;
    } catch {
      fullExit = false;
    }

    const assetMap = await buildAssetMap(chainId);
    const quotedOutRaw = route.outputs[0]?.amount ?? "0";
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    const lpDec = assetMap.get(marketAddr.toLowerCase())?.decimals ?? lpToken.decimals;

    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: "yield_lp", chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(marketAddr, assetMap.get(marketAddr.toLowerCase())?.symbol, lpDec, amountWei.toString(), humanAmount(amountWei, lpDec).toString()),
        tokenOut: legInput(outputToken, assetMap.get(outputToken.toLowerCase())?.symbol, outDec, quotedOutRaw, humanAmount(quotedOutRaw, outDec).toString()),
        routeProvenance: { action: "lp-remove", aggregator: route.data.aggregatorType, market: marketAddr, fullExit },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    const outAmount = broadcast.executed.amountOutRaw ?? quotedOutRaw;

    logger.info("pendle.lp.remove.executed", { market: marketAddr, fullExit, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash, action: "remove", market: marketAddr, tokenOut: outputToken,
        amountIn: amountInRaw,
        executedAmountOut: humanAmount(outAmount, outDec).toString(),
        quotedAmountOut: humanAmount(quotedOutRaw, outDec).toString(),
        fullExit,
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
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.lp.remove", txHash, err);
    return fail(`Pendle remove liquidity failed (${failureDetail("pendle__lp_remove", err)})`);
  }
}
