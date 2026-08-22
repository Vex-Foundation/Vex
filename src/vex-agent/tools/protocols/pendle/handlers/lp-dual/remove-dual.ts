/**
 * `pendle.lp.removeDual` — LP → token + PT, the two-output exit.
 *
 * `removeLiquidityDualTokenAndPt` carries a `minTokenOut` AND a `minPtOut`, both
 * resolved BY TOKEN rather than by index (the provider's `outputs` order is its
 * own). The durable row stages an Option-C second leg with the INTENT, and the
 * receipt decode must prove BOTH legs or the row stays pending.
 *
 * EXIT-SHAPED (R5b matrix): removal is legal after expiry, so the matured
 * catalogue is in scope. Prequote-gated — see `../lp-dual-prequote.ts`.
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

import { buildAssetMap } from "../../market-lookup.js";
import { resolveExitMarketByAddress } from "../../matured-market-lookup.js";
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
import { LP_EVENT_ROLE, REMOVE_DUAL_TOOL_ID, approveRequired, quotedLeg } from "./dual-legs.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

export async function executePendleLpRemoveDual(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const toolId = REMOVE_DUAL_TOOL_ID;
  const chain = str(p, "chain"), marketRaw = str(p, "market"), amountInRaw = str(p, "amountIn");
  if (!chain || !marketRaw || !amountInRaw) return fail(`Missing required: chain, market, amountIn (${toolId})`);
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the withdrawal is already on-chain.
  let txHash: Hex | undefined;
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
          toolId, eventRole: LP_EVENT_ROLE, chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p, tokenIn: { tokenAddress: marketAddress },
        },
        failureCode,
        message,
      );
      return fail(message);
    };

    // EXIT-SHAPED (R5b matrix): removal is legal after expiry, so the matured
    // catalogue is in scope. An inactive row is believed only on a parseable,
    // past expiry — the resolver refuses anything else by name.
    const resolved = await resolveExitMarketByAddress(chainId, marketAddress);
    if (!resolved || !resolved.market.address) {
      return refuse("route_not_found", "No Pendle market at this address - check pendle__markets_discover (includeMatured:true covers expired markets).");
    }
    const market = resolved.market;
    const marketAddr = getAddress(market.address);
    if (!market.pt) {
      return refuse("route_not_found", "This Pendle market reports no PT, so a dual remove has no second output leg - use pendle__lp_remove.");
    }
    const ptAddress = getAddress(market.pt);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return refuse("route_not_found", "No output token — pass tokenOut (the market has no underlying to default to).");
    if (outputToken === ptAddress) {
      return refuse("route_not_found", "tokenOut is this market's PT — the PT leg is delivered automatically; name a plain token instead.");
    }
    // The LP token IS the market; read its decimals on-chain like any ERC-20.
    const lpToken = await resolveInputToken(chainEntry, marketRaw);
    const amountWei = parseUnits(amountInRaw, lpToken.decimals);
    const slippage = resolvePendleSlippage(toolId, num(p, "slippageBps"));

    const isDryRun = p.dryRun === true;
    // The prequote legs are the RESOLVED ones, and both sides reach them through
    // this same sequence, so the dry run and the execute agree by construction.
    const legs = {
      chainId,
      walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
      market: marketAddr,
      token: outputToken,
      amount: amountInRaw,
    };

    // The GATE runs before Convert on the execute path: a burn with no fresh dry
    // run must not even reach the provider.
    if (!isDryRun) {
      const gate = await gatePendleLpDualExecute(toolId, "lp_remove_dual", sessionId, p, legs);
      if (gate.kind === "block") return refuse("route_not_found", gate.message);
    }

    // Signer resolution stays AFTER the dry-run branch decision so a preview never
    // decrypts a key. The dry run still binds the SELECTED address as the
    // receiver — the same address the execute signs with — so its route safety is
    // the identical check, not a weaker one against a placeholder.
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
      inputs: [{ token: marketAddr, amount: amountWei.toString() }],
      // TWO outputs is what makes Convert infer the dual action; the order sent
      // does not determine the order returned.
      outputs: [outputToken, ptAddress],
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) {
      return refuse("route_not_found", "Pendle returned no dual remove-liquidity route for this market.");
    }
    if (response.action !== "remove-liquidity-dual") {
      return refuse("route_not_found", "Pendle did not return a dual remove-liquidity route - for a single-token exit use pendle__lp_remove.");
    }

    const intent: PendleTxIntent = {
      action: "lp-remove-dual",
      wallet,
      // The tolerance BOTH legs are held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      // The "input" being spent is the LP (market) token — approvals bind to it.
      inputToken: marketAddr,
      inputAmountWei: amountWei,
      isNative: false,
      expectedMarket: marketAddr,
      // The PT leg carries no token in the calldata; the floor resolves it by
      // elimination. The TOKEN leg is bound here.
      expectedOutputToken: outputToken,
    };
    // FULL fund-safety extractor — identical on the dry run and the execute.
    const route = selectSafeRoute(intent, response);

    const assetMap = await buildAssetMap(chainId);
    const quotedTokenRaw = quotedLeg(route.outputs, outputToken, "token output");
    const quotedPtRaw = quotedLeg(route.outputs, ptAddress, "PT output");
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    const ptDec = assetMap.get(ptAddress.toLowerCase())?.decimals ?? null;
    const lpDec = assetMap.get(marketAddr.toLowerCase())?.decimals ?? lpToken.decimals;
    const quotedTokenHuman = humanAmount(quotedTokenRaw, outDec);
    const quotedPtHuman = humanAmount(quotedPtRaw, ptDec);

    if (isDryRun) {
      // Record ONLY after every safety check has passed: an unsafe route must
      // never leave an authorization behind.
      await recordPendleLpDualPrequote(toolId, "lp_remove_dual", sessionId, p, legs, {
        secondLeg: ptAddress,
        aggregator: route.data.aggregatorType ?? null,
      });
      return ok({
        dryRun: true,
        action: "lp.removeDual",
        chainId,
        market: marketAddr,
        amountIn: amountInRaw,
        tokenOut: outputToken,
        quotedAmountOut: quotedTokenHuman.toString(),
        ptOut: ptAddress,
        quotedPtOut: quotedPtHuman.toString(),
        expiry: market.expiry ?? null,
        priceImpact: route.data.priceImpact,
        feeUsdEstimate: route.data.feeUsd,
        aggregator: route.data.aggregatorType,
        slippageBps: num(p, "slippageBps") ?? VEX_DEFAULT_SLIPPAGE_BPS,
        note: "Nothing was broadcast. Call the same tool again with the EXACT same params (dryRun omitted or false) to execute.",
      });
    }

    // The dry-run branch returned above, so a signer exists here; the compiler
    // cannot see that across the branch, and a non-null assertion at a signing
    // boundary is exactly where an invariant should be checked rather than
    // asserted.
    if (signer === null) return fail(`${toolId}: no signing wallet resolved.`);

    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    await ensureErc20Balance(publicClient, {
      token: marketAddr,
      owner: wallet,
      required: amountWei,
      decimals: lpToken.decimals,
    });
    await approveRequired(response, publicClient, walletClient);

    const tokenOutUsd = legUsd(assetMap, outputToken, quotedTokenHuman);

    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: LP_EVENT_ROLE, chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(marketAddr, assetMap.get(marketAddr.toLowerCase())?.symbol, lpDec, amountWei.toString(), humanAmount(amountWei, lpDec).toString()),
        tokenOut: legInput(outputToken, assetMap.get(outputToken.toLowerCase())?.symbol, outDec, quotedTokenRaw, quotedTokenHuman.toString()),
        // Option-C second leg, staged with the INTENT: the row states both
        // instruments before a signature exists, and the receipt decode then has
        // to prove both or leave the row pending.
        tokenOut2: legInput(ptAddress, assetMap.get(ptAddress.toLowerCase())?.symbol, ptDec, quotedPtRaw, quotedPtHuman.toString()),
        ...(tokenOutUsd !== null ? { usdOutEst: String(tokenOutUsd) } : {}),
        routeProvenance: { action: "lp-remove-dual", aggregator: route.data.aggregatorType, market: marketAddr, ptAddress },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    // The RESULT is the decoded fill, never the quote. A confirmed dual row
    // carries BOTH proven legs — the decoder returns nothing at all otherwise —
    // so the quoted values stay beside them only as the comparison.
    const executedTokenRaw = broadcast.executed.amountOutRaw ?? quotedTokenRaw;
    const executedPtRaw = broadcast.executed.amountOut2Raw ?? quotedPtRaw;
    const executedLpRaw = broadcast.executed.amountInRaw ?? amountWei.toString();

    logger.info("pendle.lp.remove_dual.executed", { market: marketAddr, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash,
        action: "lp.removeDual",
        market: marketAddr,
        amountIn: amountInRaw,
        executedLpIn: humanAmount(executedLpRaw, lpDec).toString(),
        tokenOut: outputToken,
        executedAmountOut: humanAmount(executedTokenRaw, outDec).toString(),
        quotedAmountOut: quotedTokenHuman.toString(),
        ptOut: ptAddress,
        executedPtOut: humanAmount(executedPtRaw, ptDec).toString(),
        quotedPtOut: quotedPtHuman.toString(),
      }, null, 2),
      // NO `_tradeCapture`: this tool's durable truth is the `agent_activity` row
      // written by `sendPendleRouterTx`, so the legacy projection pipeline must
      // not also run for it.
      data: { txHash, _executionId: broadcast.executionId },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure(toolId, txHash, err);
    return fail(`Pendle dual remove liquidity failed (${failureDetail(toolId, err)})`);
  }
}
