/**
 * Pendle DUAL-LP handlers (R5d card E3) — `pendle.lp.removeDual` (LP → token +
 * PT) and `pendle.lp.addKeepYt` (token → LP + kept YT).
 *
 * ONE second output leg is what separates these two from the shipped
 * single-token `handlers/lp.ts` pair, and it changes four things end to end:
 *
 *   1. THE PRICE FLOOR is per leg. `removeLiquidityDualTokenAndPt` carries a
 *      `minTokenOut` AND a `minPtOut`; `addLiquiditySingleTokenKeepYt` a
 *      `minLpOut` AND a `minYtOut`. Both rows are already in
 *      `calldata/price-floor.ts`, and both resolve their leg BY TOKEN rather
 *      than by index, because the provider's `outputs` order is its own (measured
 *      2026-07-28: asking `[underlying, PT]` and `[PT, underlying]` both came
 *      back `[PT, underlying]`). This module reads its own quoted amounts the
 *      same way — by token, never positionally.
 *   2. THE DURABLE ROW carries an Option-C second leg (migration 053), which
 *      `yield_lp` permits. The INTENT stages it, so the row states both
 *      instruments before a signature exists rather than discovering the second
 *      one afterwards.
 *   3. THE RECEIPT must prove BOTH. `decodePendleSettlement` requires a proven
 *      inflow for `tokenOut2` whenever the plan names one, so a confirmed dual
 *      row can never report one leg and invent the other — an unprovable second
 *      leg leaves the row pending for the repair sweep instead.
 *   4. THE ACTION BIND. Convert labels a keep-YT add plain `"add-liquidity"` —
 *      the SAME string a single-token add returns — so the response's action
 *      field cannot tell them apart. What can, and does, is the METHOD row in
 *      `calldata/bind-route.ts`: an `lp-add-keep-yt` intent accepts only
 *      `addLiquiditySingleTokenKeepYt` calldata.
 *
 * MATURITY follows the R5b matrix by SHAPE, not by family. The dual remove is
 * exit-shaped, so it resolves matured markets through
 * `resolveExitMarketByAddress` exactly as `pendle.lp.remove` does. The keep-YT
 * add is buy-shaped — liquidity cannot be added after expiry at all — so it stays
 * ACTIVE-ONLY and names maturity as the refusal reason through
 * `explainUnresolvedPendleMarket`, reusing the `lp.add` refusal because the next
 * step it recommends is the correct one for this tool too.
 *
 * PREQUOTE — the DRY-RUN-IN-TOOL pattern. A `dryRun: true` call quotes through
 * Convert, runs the FULL fund-safety extractor, records the authorization, and
 * broadcasts nothing; the execute re-fetches, re-runs every check, and is refused
 * unless a fresh dry run with IDENTICAL params exists. See `./lp-dual-prequote.ts`.
 *
 * Upstream error text NEVER reaches the model — only bounded, code-keyed detail.
 */

import { getAddress, parseUnits, type Address, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import type { PendleConvertResponse, PendleTokenAmount } from "@tools/pendle/types.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

import { resolveMarketByAddress, buildAssetMap } from "../market-lookup.js";
import { resolveExitMarketByAddress } from "../matured-market-lookup.js";
import { explainUnresolvedPendleMarket } from "../matured-refusal.js";
import { selectSafeRoute, type PendleTxIntent } from "../calldata.js";
import { broadcastUnconfirmedFailure } from "./broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "./signed-broadcast.js";
import { gatePendleLpDualExecute, recordPendleLpDualPrequote } from "./lp-dual-prequote.js";
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

/** The activity role every dual-LP row carries (migration 053) — dual legs allowed. */
const LP_EVENT_ROLE = "yield_lp" as const;

const REMOVE_DUAL_TOOL_ID = "pendle.lp.removeDual";
const ADD_KEEP_YT_TOOL_ID = "pendle.lp.addKeepYt";

/**
 * The route's quoted amount for ONE named output leg, resolved BY TOKEN.
 *
 * Never positional: the provider's `outputs` order is its own canonical order
 * and does not echo the requested one, so reading leg 2 at index 1 would compare
 * (and later report) the wrong leg's amount. Fails CLOSED — zero matches or more
 * than one are both refusals, never a guess, because "which leg is this" is not
 * a question to answer approximately on a money path.
 */
function quotedLeg(outputs: readonly PendleTokenAmount[], token: Address, label: string): string {
  const matched = outputs.filter((o) => o.token.toLowerCase() === token.toLowerCase());
  if (matched.length !== 1) {
    throw new VexError(
      ErrorCodes.PENDLE_UNSAFE_TX,
      `Pendle did not quote exactly one ${label} leg for this route.`,
    );
  }
  return matched[0]!.amount;
}

/** Approve EXACTLY what Convert asks for, to the pinned Router — nothing else. */
async function approveRequired(
  response: PendleConvertResponse,
  publicClient: Parameters<typeof ensurePendleAllowanceExact>[0],
  walletClient: Parameters<typeof ensurePendleAllowanceExact>[1],
): Promise<void> {
  for (const approval of response.requiredApprovals) {
    await ensurePendleAllowanceExact(
      publicClient,
      walletClient,
      getAddress(approval.token),
      PENDLE_ROUTER,
      BigInt(approval.amount),
    );
  }
}

// ── removeDual (LP → token + PT) ─────────────────────────────────────

async function executePendleLpRemoveDual(
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
      return refuse("route_not_found", "No Pendle market at this address — check pendle.yields (includeMatured:true covers expired markets).");
    }
    const market = resolved.market;
    const marketAddr = getAddress(market.address);
    if (!market.pt) {
      return refuse("route_not_found", "This Pendle market reports no PT, so a dual remove has no second output leg — use pendle.lp.remove.");
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
      return refuse("route_not_found", "Pendle did not return a dual remove-liquidity route — for a single-token exit use pendle.lp.remove.");
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
        slippageBps: num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS,
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

// ── addKeepYt (token → LP + YT) ──────────────────────────────────────

async function executePendleLpAddKeepYt(
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
      return refuse("route_not_found", "This Pendle market reports no YT, so there is no yield token to keep — use pendle.lp.add.");
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
        slippageBps: num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS,
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

export const PENDLE_LP_DUAL_HANDLERS: Record<string, ProtocolHandler> = {
  [REMOVE_DUAL_TOOL_ID]: (p, ctx) => executePendleLpRemoveDual(p, ctx),
  [ADD_KEEP_YT_TOOL_ID]: (p, ctx) => executePendleLpAddKeepYt(p, ctx),
};
