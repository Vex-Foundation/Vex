/**
 * Pendle TERM-MOBILITY handlers (R5d card E4) — `pendle.pt.rollover`
 * (PT → later-expiry PT), `pendle.lp.transfer` (LP → LP) and `pendle.lp.toPt`
 * (LP → the same market's PT).
 *
 * TWO CALLDATA SHAPES, MEASURED NOT ASSUMED (`calldata/bind-reflect.ts`, D1's
 * live probes 2026-07-28):
 *   - `roll-over-pt` and `transfer-liquidity` come back as `callAndReflect`
 *     bodies carrying whole Router calls as `bytes`, so they are bound by
 *     `selectSafeReflectRoute` — which the E2 card owns. This module CONSUMES
 *     that binder and never restates a reflector rule.
 *   - `convert-lp-to-pt` came back as a PLAIN single-leg `removeLiquiditySinglePt`
 *     despite sharing the family, so it goes through the ordinary
 *     `selectSafeRoute` with the `lp-to-pt` ACTION_METHODS row.
 *
 * THE MATURITY MATRIX (R5b), applied per leg rather than per tool. Each of these
 * actions has a SOURCE the user already holds and a DESTINATION they are buying
 * into:
 *   - SOURCE  → resolved through the EXIT resolver, so a matured position can
 *     still be rolled or transferred out of. Being unable to leave an expired
 *     position is the failure mode the matrix exists to prevent.
 *   - DESTINATION → resolved ACTIVE-ONLY, and a matured one is refused BY NAME
 *     through `explainUnresolvedPendleMarket`, which reports the expiry date and
 *     the tool that does work instead. `pendle.lp.toPt` is destination-shaped on
 *     its ONE market (it acquires that market's PT), so it is active-only end to
 *     end and says so.
 *
 * PREQUOTE — the DRY-RUN-IN-TOOL pattern. A `dryRun: true` call quotes through
 * Convert, runs the FULL fund-safety extractor, records the authorization, and
 * broadcasts nothing. The execute re-fetches Convert, re-runs every check, and is
 * refused unless a fresh dry run with IDENTICAL params exists. See
 * `./reflect-prequote.ts`.
 *
 * Upstream error text NEVER reaches the model — only bounded, code-keyed detail.
 */

import { getAddress, parseUnits, type Address, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import type { PendleMarket } from "@tools/pendle/types.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

import { buildAssetMap, resolveMarketByAddress, resolveMarketByPt } from "../market-lookup.js";
import { resolveExitMarketByAddress, resolveExitMarketByPt } from "../matured-market-lookup.js";
import { explainUnresolvedPendleMarket } from "../matured-refusal.js";
import { amountTriplet, percentString } from "../money-format.js";
import { trustedNumber } from "../trusted-fields.js";
import { selectSafeRoute, type PendleTxIntent } from "../calldata.js";
import { selectSafeReflectRoute, type PendleReflectIntent } from "../calldata/bind-reflect.js";
import { broadcastUnconfirmedFailure } from "./broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx, type PendleActivityRole } from "./signed-broadcast.js";
import {
  gatePendleTermExecute,
  recordPendleTermPrequote,
  type PendleTermAction,
  type PendleTermLegs,
} from "./reflect-prequote.js";
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
} from "./shared.js";

/**
 * The activity role each tool's row carries (migration 053). A rollover moves a
 * PT (`yield_pt`); an LP transfer and an LP→PT conversion both spend an LP
 * (`yield_lp`). All three are ONE-IN-ONE-OUT, so the Option-C second-leg columns
 * stay NULL and migration 053's dual invariants do not apply.
 */
const ROLLOVER_ROLE: PendleActivityRole = "yield_pt";
const LP_ROLE: PendleActivityRole = "yield_lp";

/** The market's implied APY as a percent string, or null when unreported. */
function impliedApyPercent(market: PendleMarket): string | null {
  return percentString(trustedNumber(market.details.impliedApy, 100));
}

/**
 * The route output for a KNOWN token — never `outputs[0]`.
 *
 * The provider's `outputs` order is its OWN canonical order and does not echo
 * the request (measured 2026-07-28, `calldata/price-floor.ts`), so reading a leg
 * positionally is how a raw amount ends up attributed to the wrong token.
 */
function outputAmountFor(outputs: readonly { token: string; amount: string }[], token: Address): string {
  return outputs.find((o) => o.token.toLowerCase() === token.toLowerCase())?.amount ?? "0";
}

// ── PT rollover (PT → later-expiry PT) ───────────────────────────────

async function executePendlePtRollover(
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
        slippageBps: num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS,
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

// ── LP transfer (LP → LP) ────────────────────────────────────────────

async function executePendleLpTransfer(
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

// ── LP → PT (single market, PLAIN single-leg route) ──────────────────

async function executePendleLpToPt(
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
    // matured LP is not stranded — `pendle.lp.remove` works after expiry, and the
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
    // refused BY NAME, and a PT from a DIFFERENT UNDERLYING is named as such —
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
            ? `${toolId}: ${expectedPt} is a PT of a DIFFERENT ${chainSlug} market with the same underlying asset — this tool only converts an LP into its OWN market's PT (${ptOut}). To reach another maturity, convert here first and then roll with pendle.pt.rollover.`
            : `${toolId}: ${expectedPt} is not this market's PT — refusing a CROSS-UNDERLYING conversion. This market's PT is ${ptOut}; the two represent different underlying assets, so Vex will not substitute one for the other.`,
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
      // The "input" being spent is the LP (market) token — approvals bind to it.
      inputToken: marketAddr,
      inputAmountWei: amountWei,
      isNative: false,
      expectedMarket: marketAddr,
      // NO `expectedOutputToken`: `removeLiquiditySinglePt` pays out PT and
      // carries no TokenOutput tuple to bind (see calldata/decode.ts).
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
        slippageBps: num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS,
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

/**
 * The three term-mobility handlers. UNREGISTERED by design (R5d E4): the
 * integration card wires these into `../handlers.ts` and `../manifest.ts`
 * together with the mutation-matrix row each tool needs, so the exact-24
 * manifest lock stays green until that lands.
 */
export const PENDLE_TERM_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.pt.rollover": (p, ctx) => executePendlePtRollover(p, ctx),
  "pendle.lp.transfer": (p, ctx) => executePendleLpTransfer(p, ctx),
  "pendle.lp.toPt": (p, ctx) => executePendleLpToPt(p, ctx),
};

/** The `PendleTermAction` each toolId records/gates under — pinned by tests. */
export const PENDLE_TERM_TOOL_ACTIONS: Readonly<Record<string, PendleTermAction>> = {
  "pendle.pt.rollover": "pt_rollover",
  "pendle.lp.transfer": "lp_transfer",
  "pendle.lp.toPt": "lp_to_pt",
};
