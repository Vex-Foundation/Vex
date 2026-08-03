/**
 * `pendle.pt.rollover` — PT → later-expiry PT.
 *
 * A `callAndReflect` body carrying whole Router calls as `bytes`, so the route
 * is bound by `selectSafeReflectRoute` (the E2 card owns that binder; this
 * module consumes it and never restates a reflector rule).
 *
 * MATURITY MATRIX (R5b), per leg: the SOURCE PT resolves through the EXIT
 * resolver so a matured position can still be rolled out of; the DESTINATION PT
 * resolves ACTIVE-ONLY and a matured one is refused BY NAME.
 *
 * PREQUOTE: a `dryRun: true` call quotes through Convert, runs the full
 * fund-safety extractor, records the authorization, and broadcasts nothing.
 */

import { getAddress, parseUnits, type Address, type Hex } from "viem";

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

import { buildAssetMap, resolveMarketByPt } from "../../market-lookup.js";
import { resolveExitMarketByPt } from "../../matured-market-lookup.js";
import { explainUnresolvedPendleMarket } from "../../matured-refusal.js";
import { amountTriplet } from "../../money-format.js";
import { selectSafeReflectRoute, type PendleReflectIntent } from "../../calldata/bind-reflect.js";
import { broadcastUnconfirmedFailure } from "../broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "../signed-broadcast.js";
import {
  gatePendleTermExecute,
  recordPendleTermPrequote,
  type PendleTermLegs,
} from "../reflect-prequote.js";
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
import { ROLLOVER_ROLE, impliedApyPercent, outputAmountFor } from "./term-legs.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

export async function executePendlePtRollover(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const toolId = "pendle.pt.rollover";
  const chain = str(p, "chain"), fromPtRaw = str(p, "fromPt"), toPtRaw = str(p, "toPt"), amountInRaw = str(p, "amountIn");
  if (!chain || !fromPtRaw || !toPtRaw || !amountInRaw) {
    return fail(`Missing required: chain, fromPt, toPt, amountIn (${toolId})`);
  }
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the roll is already on-chain.
  let txHash: Hex | undefined;
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);

    const fromPt = requireTokenAddress(fromPtRaw);
    const toPt = requireTokenAddress(toPtRaw);

    /** A pre-signature refusal, recorded as a hashless `definitively_failed` row. */
    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: ROLLOVER_ROLE, chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p,
          tokenIn: { tokenAddress: fromPt },
          tokenOut: { tokenAddress: toPt },
        },
        failureCode,
        message,
      );
      return fail(message);
    };

    if (fromPt === toPt) {
      return refuse("route_not_found", `${toolId}: fromPt and toPt are the same PT — a roll must change maturity.`);
    }

    // SOURCE — exit-shaped: a matured PT is exactly what a roll leaves behind.
    const source = await resolveExitMarketByPt(chainId, fromPt);
    if (!source || !source.market.address) {
      return refuse(
        "route_not_found",
        "No Pendle market on this chain has that fromPt — check pendle.yields (includeMatured:true covers expired markets).",
      );
    }
    // DESTINATION — buy-shaped: ACTIVE ONLY, and maturity is named as the reason.
    const destination = await resolveMarketByPt(chainId, toPt);
    if (!destination || !destination.address) {
      return refuse(
        "route_not_found",
        await explainUnresolvedPendleMarket(chainId, chainSlug, toPt, { action: "pt.buy", leg: "PT" }),
      );
    }
    const sourceMarket = getAddress(source.market.address);
    const destMarket = getAddress(destination.address);

    const ptIn = await resolveInputToken(chainEntry, fromPtRaw);
    const amountWei = parseUnits(amountInRaw, ptIn.decimals);
    const slippage = resolvePendleSlippage(toolId, num(p, "slippageBps"));
    const legs: PendleTermLegs = { source: fromPt, destination: toPt, amount: amountInRaw };

    const isDryRun = p.dryRun === true;
    // The prequote GATE runs before anything else on the execute path: a roll
    // with no fresh dry run must not even reach Convert.
    if (!isDryRun) {
      const gate = await gatePendleTermExecute(toolId, "pt_rollover", sessionId, p, context, legs);
      if (gate.kind === "block") return refuse("route_not_found", gate.message);
    }

    // Signer resolution stays AFTER the dry-run decision so a preview never
    // decrypts a key. The dry run still binds the SELECTED address, so its route
    // safety is the identical check rather than a weaker one on a placeholder.
    let wallet: Address;
    let signer: ChainWallet | null = null;
    if (isDryRun) {
      wallet = getAddress(resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"));
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
      inputs: [{ token: fromPt, amount: amountWei.toString() }],
      outputs: [toPt],
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) {
      return refuse("route_not_found", "Pendle returned no roll-over route between these two PTs.");
    }
    if (response.action !== "roll-over-pt") {
      return refuse("route_not_found", "Pendle did not return a roll-over-pt route — for a plain PT buy use pendle.pt.buy.");
    }

    const intent: PendleReflectIntent = {
      action: "pt-rollover",
      chainId,
      wallet,
      inputToken: fromPt,
      inputAmountWei: amountWei,
      // The tolerance every leg is held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      // In EXECUTION order: leg 1 sells out of the source market, the final leg
      // buys into the destination.
      expectedLegMarkets: [sourceMarket, destMarket],
      // A roll delivers the DESTINATION PT and nothing else. The final leg's
      // `minPtOut` names no token, so this is what ties its floor to the asset
      // the caller is actually buying.
      expectedRouteOutputs: [toPt],
    };
    const route = selectSafeReflectRoute(intent, response);

    const assetMap = await buildAssetMap(chainId);
    const quotedOutRaw = outputAmountFor(route.outputs, toPt);
    const outDecimals = assetMap.get(toPt.toLowerCase())?.decimals ?? null;

    const terms = {
      fromExpiry: source.market.expiry ?? null,
      toExpiry: destination.expiry ?? null,
      impliedApyBeforePercent: impliedApyPercent(source.market),
      impliedApyAfterPercent: impliedApyPercent(destination),
    };

    if (isDryRun) {
      // Record ONLY after every safety check has passed: an unsafe route must
      // never leave an authorization behind.
      await recordPendleTermPrequote(toolId, "pt_rollover", sessionId, p, context, legs, {
        action: "pt_rollover",
        source: fromPt,
        destination: toPt,
        aggregator: route.data.aggregatorType ?? null,
      });
      return ok({
        dryRun: true,
        action: "pt.rollover",
        chainId,
        fromPt,
        toPt,
        fromMarket: sourceMarket,
        toMarket: destMarket,
        sourceMatured: source.maturity === "matured",
        ...terms,
        amountIn: amountTriplet(amountWei.toString(), ptIn.decimals),
        quotedAmountOut: amountTriplet(quotedOutRaw, outDecimals),
        priceImpact: route.data.priceImpact,
        feeUsdEstimate: route.data.feeUsd,
        aggregator: route.data.aggregatorType,
        slippageBps: num(p, "slippageBps") ?? VEX_DEFAULT_SLIPPAGE_BPS,
        note: "Nothing was broadcast. Call the same tool again with the EXACT same params (dryRun omitted or false) to execute.",
      });
    }

    // The dry-run branch returned above, so a signer exists here; the compiler
    // cannot see that across the branch, and a non-null assertion at a signing
    // boundary is exactly where an invariant should be checked, not asserted.
    if (signer === null) return fail(`${toolId}: no signing wallet resolved.`);

    const inHuman = humanAmount(amountWei, ptIn.decimals);
    const quotedOutHuman = humanAmount(quotedOutRaw, outDecimals);
    const inUsd = legUsd(assetMap, fromPt, inHuman);
    const quotedOutUsd = legUsd(assetMap, toPt, quotedOutHuman);

    // Approve EXACTLY the source PT to the pinned Router (the reflect binder
    // already asserted the response asks for that one approval and nothing else).
    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    await ensureErc20Balance(publicClient, {
      token: fromPt,
      owner: wallet,
      required: amountWei,
      decimals: ptIn.decimals,
    });
    await ensurePendleAllowanceExact(publicClient, walletClient, fromPt, PENDLE_ROUTER, amountWei);

    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      // A reflect route spends an ERC20 PT, never native — the binder refuses a
      // non-zero value outright.
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: ROLLOVER_ROLE, chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(fromPt, assetMap.get(fromPt.toLowerCase())?.symbol, ptIn.decimals, amountWei.toString(), inHuman.toString()),
        tokenOut: legInput(toPt, assetMap.get(toPt.toLowerCase())?.symbol, outDecimals, quotedOutRaw, quotedOutHuman.toString()),
        ...(inUsd !== null ? { usdInEst: String(inUsd) } : {}),
        ...(quotedOutUsd !== null ? { usdOutEst: String(quotedOutUsd) } : {}),
        routeProvenance: {
          action: "pt-rollover",
          aggregator: route.data.aggregatorType,
          fromMarket: sourceMarket,
          toMarket: destMarket,
          sourceMatured: source.maturity === "matured",
        },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    // The RESULT is the decoded fill, never the quote; the quote stays beside it
    // so the agent can see the slippage it actually got.
    const executedOutRaw = broadcast.executed.amountOutRaw ?? quotedOutRaw;
    const executedInRaw = broadcast.executed.amountInRaw ?? amountWei.toString();

    logger.info("pendle.pt.rollover.executed", { fromMarket: sourceMarket, toMarket: destMarket, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash,
        action: "pt.rollover",
        fromPt,
        toPt,
        fromMarket: sourceMarket,
        toMarket: destMarket,
        ...terms,
        executedAmountIn: amountTriplet(executedInRaw, ptIn.decimals),
        executedAmountOut: amountTriplet(executedOutRaw, outDecimals),
        quotedAmountOut: amountTriplet(quotedOutRaw, outDecimals),
      }, null, 2),
      // NO `_tradeCapture`: this tool's durable truth is the `agent_activity` row
      // written by `sendPendleRouterTx`.
      data: { txHash, _executionId: broadcast.executionId },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure(toolId, txHash, err);
    return fail(`Pendle PT rollover failed (${failureDetail(toolId, err)})`);
  }
}
