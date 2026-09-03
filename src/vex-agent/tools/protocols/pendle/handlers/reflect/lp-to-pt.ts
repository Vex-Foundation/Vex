/**
 * `pendle.lp.toPt` - LP → the same market's PT.
 *
 * `convert-lp-to-pt` came back as a PLAIN single-leg `removeLiquiditySinglePt`
 * despite sharing the term-mobility family (measured 2026-07-28), so it goes
 * through the ordinary `selectSafeRoute` with the `lp-to-pt` ACTION_METHODS row
 * rather than the reflect binder.
 *
 * ACTIVE-ONLY end to end: the action ACQUIRES the market's PT, so it is
 * destination-shaped even though both legs belong to one market.
 */

import { getAddress, parseUnits, type Address, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@vex-agent/tools/protocols/pendle/allowance.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { buildAssetMap, resolveMarketByAddress } from "../../market-lookup.js";
import { resolveExitMarketByPt } from "../../matured-market-lookup.js";
import { explainUnresolvedPendleMarket } from "../../matured-refusal.js";
import { amountTriplet } from "../../money-format.js";
import { selectSafeRoute, type PendleTxIntent } from "../../calldata.js";
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
import { LP_ROLE, impliedApyPercent, outputAmountFor } from "./term-legs.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

export async function executePendleLpToPt(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const toolId = "pendle.lp.toPt";
  const chain = str(p, "chain"), marketRaw = str(p, "market"), amountInRaw = str(p, "amountIn");
  if (!chain || !marketRaw || !amountInRaw) {
    return fail(`Missing required: chain, market, amountIn (${toolId})`);
  }
  let txHash: Hex | undefined;
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);

    const marketParam = requireTokenAddress(marketRaw);
    const expectedPtRaw = str(p, "pt");

    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: LP_ROLE, chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p,
          tokenIn: { tokenAddress: marketParam },
        },
        failureCode,
        message,
      );
      return fail(message);
    };

    // ACTIVE-ONLY, end to end. This action ACQUIRES the market's PT, so it is
    // destination-shaped even though both legs belong to one market: buying into
    // a matured market is the thing the R5b matrix refuses. The holder of a
    // matured LP is not stranded - `pendle.lp.remove` works after expiry, and the
    // refusal says so by name.
    const market = await resolveMarketByAddress(chainId, marketParam);
    if (!market || !market.address) {
      return refuse(
        "route_not_found",
        `${toolId} cannot convert into a matured market's PT. `
        + await explainUnresolvedPendleMarket(chainId, chainSlug, marketParam, { action: "lp.add", leg: "market" }),
      );
    }
    const marketAddr = getAddress(market.address);
    if (!market.pt) {
      return refuse("route_not_found", `${toolId}: this Pendle market reports no PT address, so there is nothing to convert into.`);
    }
    const ptOut = getAddress(market.pt);

    // The optional `pt` param is a CHECK on Vex's own resolution, never a
    // destination: this route is a single-leg `removeLiquiditySinglePt` on ONE
    // market, so the PT it can deliver is that market's own. A mismatch is
    // refused BY NAME, and a PT from a DIFFERENT UNDERLYING is named as such -
    // the two mistakes need different corrections.
    if (expectedPtRaw) {
      const expectedPt = requireTokenAddress(expectedPtRaw);
      if (expectedPt !== ptOut) {
        const other = await resolveExitMarketByPt(chainId, expectedPt);
        const sameUnderlying =
          other?.market.underlyingAsset && market.underlyingAsset
            ? other.market.underlyingAsset.toLowerCase() === market.underlyingAsset.toLowerCase()
            : false;
        return refuse(
          "route_not_found",
          sameUnderlying
            ? `${toolId}: ${expectedPt} is a PT of a DIFFERENT ${chainSlug} market with the same underlying asset - this tool only converts an LP into its OWN market's PT (${ptOut}). To reach another maturity, convert here first and then roll with pendle__pt_rollover.`
            : `${toolId}: ${expectedPt} is not this market's PT - refusing a CROSS-UNDERLYING conversion. This market's PT is ${ptOut}; the two represent different underlying assets, so Vex will not substitute one for the other.`,
        );
      }
    }

    const lpIn = await resolveInputToken(chainEntry, marketRaw);
    const amountWei = parseUnits(amountInRaw, lpIn.decimals);
    const slippage = resolvePendleSlippage(toolId, num(p, "slippageBps"));
    const legs: PendleTermLegs = { source: marketAddr, destination: ptOut, amount: amountInRaw };

    const isDryRun = p.dryRun === true;
    if (!isDryRun) {
      const gate = await gatePendleTermExecute(toolId, "lp_to_pt", sessionId, p, context, legs);
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
      inputs: [{ token: marketAddr, amount: amountWei.toString() }],
      outputs: [ptOut],
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) {
      return refuse("route_not_found", "Pendle returned no LP→PT route for this market.");
    }
    // `convert-lp-to-pt` reports the PLAIN `remove-liquidity` action string
    // (measured 2026-07-28); it is the route's METHOD, bound below by the
    // `lp-to-pt` ACTION_METHODS row, that identifies the variant.
    if (response.action !== "remove-liquidity") {
      return refuse("route_not_found", "Pendle did not return a remove-liquidity route for this market.");
    }

    const intent: PendleTxIntent = {
      action: "lp-to-pt",
      wallet,
      slippageBps: slippage.bps,
      // The "input" being spent is the LP (market) token - approvals bind to it.
      inputToken: marketAddr,
      inputAmountWei: amountWei,
      isNative: false,
      expectedMarket: marketAddr,
      // NO `expectedOutputToken`: `removeLiquiditySinglePt` pays out PT and
      // carries no TokenOutput tuple to bind (see calldata/decode.ts). Because
      // the calldata names no output token, the route's DECLARED outputs are
      // pinned instead - otherwise `minPtOut` would be floored against whatever
      // token the response declared.
      expectedRouteOutputs: [ptOut],
    };
    const route = selectSafeRoute(intent, response);

    const assetMap = await buildAssetMap(chainId);
    const quotedOutRaw = outputAmountFor(route.outputs, ptOut);
    const outDecimals = assetMap.get(ptOut.toLowerCase())?.decimals ?? null;
    const terms = {
      expiry: market.expiry ?? null,
      impliedApyPercent: impliedApyPercent(market),
    };

    if (isDryRun) {
      await recordPendleTermPrequote(toolId, "lp_to_pt", sessionId, p, context, legs, {
        action: "lp_to_pt",
        source: marketAddr,
        destination: ptOut,
        aggregator: route.data.aggregatorType ?? null,
      });
      return ok({
        dryRun: true,
        action: "lp.toPt",
        chainId,
        market: marketAddr,
        pt: ptOut,
        ...terms,
        amountIn: amountTriplet(amountWei.toString(), lpIn.decimals),
        quotedAmountOut: amountTriplet(quotedOutRaw, outDecimals),
        priceImpact: route.data.priceImpact,
        feeUsdEstimate: route.data.feeUsd,
        aggregator: route.data.aggregatorType,
        slippageBps: num(p, "slippageBps") ?? VEX_DEFAULT_SLIPPAGE_BPS,
        note: "Nothing was broadcast. Call the same tool again with the EXACT same params (dryRun omitted or false) to execute.",
      });
    }

    if (signer === null) return fail(`${toolId}: no signing wallet resolved.`);

    const inHuman = humanAmount(amountWei, lpIn.decimals);
    const quotedOutHuman = humanAmount(quotedOutRaw, outDecimals);
    const inUsd = legUsd(assetMap, marketAddr, inHuman);
    const quotedOutUsd = legUsd(assetMap, ptOut, quotedOutHuman);

    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    await ensureErc20Balance(publicClient, {
      token: marketAddr,
      owner: wallet,
      required: amountWei,
      decimals: lpIn.decimals,
    });
    await ensurePendleAllowanceExact(publicClient, walletClient, marketAddr, PENDLE_ROUTER, amountWei);

    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: LP_ROLE, chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(marketAddr, assetMap.get(marketAddr.toLowerCase())?.symbol, lpIn.decimals, amountWei.toString(), inHuman.toString()),
        tokenOut: legInput(ptOut, assetMap.get(ptOut.toLowerCase())?.symbol, outDecimals, quotedOutRaw, quotedOutHuman.toString()),
        ...(inUsd !== null ? { usdInEst: String(inUsd) } : {}),
        ...(quotedOutUsd !== null ? { usdOutEst: String(quotedOutUsd) } : {}),
        routeProvenance: { action: "lp-to-pt", aggregator: route.data.aggregatorType, market: marketAddr, pt: ptOut },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    const executedOutRaw = broadcast.executed.amountOutRaw ?? quotedOutRaw;
    const executedInRaw = broadcast.executed.amountInRaw ?? amountWei.toString();

    logger.info("pendle.lp.toPt.executed", { market: marketAddr, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash,
        action: "lp.toPt",
        market: marketAddr,
        pt: ptOut,
        ...terms,
        executedAmountIn: amountTriplet(executedInRaw, lpIn.decimals),
        executedAmountOut: amountTriplet(executedOutRaw, outDecimals),
        quotedAmountOut: amountTriplet(quotedOutRaw, outDecimals),
      }, null, 2),
      data: { txHash, _executionId: broadcast.executionId },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure(toolId, txHash, err);
    return fail(`Pendle LP→PT conversion failed (${failureDetail(toolId, err)})`);
  }
}
