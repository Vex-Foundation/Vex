/**
 * `pendle.lp.transfer` — LP → LP across two markets.
 *
 * A `transfer-liquidity` Convert response comes back as a `callAndReflect` body
 * carrying whole Router calls as `bytes`, so it is bound by
 * `selectSafeReflectRoute` rather than the plain single-leg binder.
 *
 * MATURITY MATRIX (R5b), per leg: the SOURCE market resolves through the EXIT
 * resolver — leaving a matured pool is legal and necessary — while the
 * DESTINATION resolves ACTIVE-ONLY and names maturity as the refusal reason.
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

import { buildAssetMap, resolveMarketByAddress } from "../../market-lookup.js";
import { resolveExitMarketByAddress } from "../../matured-market-lookup.js";
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
  DEFAULT_SLIPPAGE_BPS,
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
import { LP_ROLE, impliedApyPercent, outputAmountFor } from "./term-legs.js";

export async function executePendleLpTransfer(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const toolId = "pendle.lp.transfer";
  const chain = str(p, "chain"), fromRaw = str(p, "fromMarket"), toRaw = str(p, "toMarket"), amountInRaw = str(p, "amountIn");
  if (!chain || !fromRaw || !toRaw || !amountInRaw) {
    return fail(`Missing required: chain, fromMarket, toMarket, amountIn (${toolId})`);
  }
  let txHash: Hex | undefined;
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);

    const fromMarketParam = requireTokenAddress(fromRaw);
    const toMarketParam = requireTokenAddress(toRaw);

    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: LP_ROLE, chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p,
          tokenIn: { tokenAddress: fromMarketParam },
          tokenOut: { tokenAddress: toMarketParam },
        },
        failureCode,
        message,
      );
      return fail(message);
    };

    if (fromMarketParam === toMarketParam) {
      return refuse("route_not_found", `${toolId}: fromMarket and toMarket are the same market — there is nothing to move.`);
    }

    // SOURCE — exit-shaped: leaving a matured pool is legal and necessary.
    const source = await resolveExitMarketByAddress(chainId, fromMarketParam);
    if (!source || !source.market.address) {
      return refuse(
        "route_not_found",
        "No Pendle market at that fromMarket address — check pendle.yields (includeMatured:true covers expired markets).",
      );
    }
    // DESTINATION — buy-shaped: ACTIVE ONLY; maturity named via the read lane.
    const destination = await resolveMarketByAddress(chainId, toMarketParam);
    if (!destination || !destination.address) {
      return refuse(
        "route_not_found",
        await explainUnresolvedPendleMarket(chainId, chainSlug, toMarketParam, { action: "lp.add", leg: "market" }),
      );
    }
    const fromMarket = getAddress(source.market.address);
    const toMarket = getAddress(destination.address);

    // The market IS the LP token — read its decimals on-chain like any ERC-20.
    const lpIn = await resolveInputToken(chainEntry, fromRaw);
    const amountWei = parseUnits(amountInRaw, lpIn.decimals);
    const slippage = resolvePendleSlippage(toolId, num(p, "slippageBps"));
    const legs: PendleTermLegs = { source: fromMarket, destination: toMarket, amount: amountInRaw };

    const isDryRun = p.dryRun === true;
    if (!isDryRun) {
      const gate = await gatePendleTermExecute(toolId, "lp_transfer", sessionId, p, context, legs);
      if (gate.kind === "block") return refuse("route_not_found", gate.message);
    }

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
      inputs: [{ token: fromMarket, amount: amountWei.toString() }],
      outputs: [toMarket],
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) {
      return refuse("route_not_found", "Pendle returned no transfer-liquidity route between these two markets.");
    }
    if (response.action !== "transfer-liquidity") {
      return refuse("route_not_found", "Pendle did not return a transfer-liquidity route — to withdraw to a token use pendle.lp.remove.");
    }

    const intent: PendleReflectIntent = {
      action: "lp-transfer",
      chainId,
      wallet,
      inputToken: fromMarket,
      inputAmountWei: amountWei,
      slippageBps: slippage.bps,
      expectedLegMarkets: [fromMarket, toMarket],
      // A transfer delivers the DESTINATION market's LP — the market IS its LP
      // token — and nothing else.
      expectedRouteOutputs: [toMarket],
    };
    const route = selectSafeReflectRoute(intent, response);

    const assetMap = await buildAssetMap(chainId);
    const quotedOutRaw = outputAmountFor(route.outputs, toMarket);
    const outDecimals = assetMap.get(toMarket.toLowerCase())?.decimals ?? null;

    const terms = {
      fromExpiry: source.market.expiry ?? null,
      toExpiry: destination.expiry ?? null,
      impliedApyBeforePercent: impliedApyPercent(source.market),
      impliedApyAfterPercent: impliedApyPercent(destination),
    };

    if (isDryRun) {
      await recordPendleTermPrequote(toolId, "lp_transfer", sessionId, p, context, legs, {
        action: "lp_transfer",
        source: fromMarket,
        destination: toMarket,
        aggregator: route.data.aggregatorType ?? null,
      });
      return ok({
        dryRun: true,
        action: "lp.transfer",
        chainId,
        fromMarket,
        toMarket,
        sourceMatured: source.maturity === "matured",
        ...terms,
        amountIn: amountTriplet(amountWei.toString(), lpIn.decimals),
        quotedAmountOut: amountTriplet(quotedOutRaw, outDecimals),
        priceImpact: route.data.priceImpact,
        feeUsdEstimate: route.data.feeUsd,
        aggregator: route.data.aggregatorType,
        slippageBps: num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS,
        note: "Nothing was broadcast. Call the same tool again with the EXACT same params (dryRun omitted or false) to execute.",
      });
    }

    if (signer === null) return fail(`${toolId}: no signing wallet resolved.`);

    const inHuman = humanAmount(amountWei, lpIn.decimals);
    const quotedOutHuman = humanAmount(quotedOutRaw, outDecimals);
    const inUsd = legUsd(assetMap, fromMarket, inHuman);
    const quotedOutUsd = legUsd(assetMap, toMarket, quotedOutHuman);

    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    await ensureErc20Balance(publicClient, {
      token: fromMarket,
      owner: wallet,
      required: amountWei,
      decimals: lpIn.decimals,
    });
    await ensurePendleAllowanceExact(publicClient, walletClient, fromMarket, PENDLE_ROUTER, amountWei);

    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: LP_ROLE, chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(fromMarket, assetMap.get(fromMarket.toLowerCase())?.symbol, lpIn.decimals, amountWei.toString(), inHuman.toString()),
        tokenOut: legInput(toMarket, assetMap.get(toMarket.toLowerCase())?.symbol, outDecimals, quotedOutRaw, quotedOutHuman.toString()),
        ...(inUsd !== null ? { usdInEst: String(inUsd) } : {}),
        ...(quotedOutUsd !== null ? { usdOutEst: String(quotedOutUsd) } : {}),
        routeProvenance: {
          action: "lp-transfer",
          aggregator: route.data.aggregatorType,
          fromMarket,
          toMarket,
          sourceMatured: source.maturity === "matured",
        },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    const executedOutRaw = broadcast.executed.amountOutRaw ?? quotedOutRaw;
    const executedInRaw = broadcast.executed.amountInRaw ?? amountWei.toString();

    logger.info("pendle.lp.transfer.executed", { fromMarket, toMarket, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash,
        action: "lp.transfer",
        fromMarket,
        toMarket,
        ...terms,
        executedAmountIn: amountTriplet(executedInRaw, lpIn.decimals),
        executedAmountOut: amountTriplet(executedOutRaw, outDecimals),
        quotedAmountOut: amountTriplet(quotedOutRaw, outDecimals),
      }, null, 2),
      data: { txHash, _executionId: broadcast.executionId },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure(toolId, txHash, err);
    return fail(`Pendle LP transfer failed (${failureDetail(toolId, err)})`);
  }
}
