/**
 * Pendle PT handlers — quote (read) + buy / sell / redeem (mutating).
 *
 * Quote hits Convert to preview a route and records the prequote (swap for a
 * buy/early-exit sell, redeem for a matured PT). Every mutating path RE-FETCHES
 * Convert, then runs the fund-safety extractor (`../calldata.ts`, LOCKED G2#1)
 * before signing: Router pin, sender/value bind, EXACT approval-set bind, and
 * calldata intent bind (selector + decoded receiver == wallet + market/YT ==
 * quoted). Nothing is signed unless every check passes. Redeem has an
 * API-independent `redeemPyToSy` fallback for a matured position when Convert is
 * unavailable.
 *
 * Upstream error text NEVER reaches the model — only bounded, code-keyed detail.
 */

import { getAddress, parseUnits, type Address, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import type { PendleConvertResponse } from "@tools/pendle/types.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

import { resolveMarketByPt, buildAssetMap } from "../market-lookup.js";
import { resolveExitMarketByPt } from "../matured-market-lookup.js";
import { explainUnresolvedPendleMarket } from "../matured-refusal.js";
import { selectSafeRoute, type PendleAction, type PendleTxIntent } from "../calldata.js";
import { assertPtMaturedForFallback, buildRedeemPyToSyPlan } from "../redeem-fallback.js";
import { broadcastUnconfirmedFailure } from "./broadcast-unconfirmed.js";
import { sendPendleRouterTx } from "./signed-broadcast.js";
import { recordPendleRefusal } from "./signed-broadcast.js";
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

// ── Quote ────────────────────────────────────────────────────────────

async function pendlePtQuote(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) {
    return fail("Missing required: chain, tokenIn, tokenOut, amountIn");
  }
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const receiver = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    const tokenOut = requireTokenAddress(tokenOutRaw);

    // INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): one leg must be an
    // active PT on the resolved chain (out → buy, in → sell/redeem). Mirrors the
    // execute side (which already fails without a market) and the YT quote's
    // guard: a quote with NO PT leg must never record a generic swap identity
    // that could authorize a same-legged execute on the wrong instrument.
    // R5b matrix. PT as OUT is a BUY, which is active-only. PT as IN is a sell
    // OR a redeem — and on a MATURED PT it can only be a redeem (Convert answers
    // `redeem-py`), which is an allowed exit, so the in-leg resolves the matured
    // catalogue too. `pt.sell`'s own execute stays active-only and refuses by
    // name, so a matured quote can only ever authorize the redeem.
    const marketByOut = await resolveMarketByPt(chainId, tokenOut);
    const exitByIn = await resolveExitMarketByPt(chainId, tokenIn.address);
    const marketByIn = exitByIn?.market ?? null;
    if (!marketByOut && !marketByIn) {
      return fail(await explainUnresolvedPendleMarket(chainId, chainEntry.slug, tokenIn.address, { action: "pt.buy", leg: "PT" }));
    }
    const ptIsOut = marketByOut !== null;
    const ptAddress = ptIsOut ? tokenOut : tokenIn.address;
    const market = ptIsOut ? marketByOut : marketByIn;

    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = resolvePendleSlippage("pendle.pt.quote", num(p, "slippageBps"));

    const client = getPendleClient();
    const response = await client.convert(chainId, {
      receiver,
      input: { token: tokenIn.address, amount: amountWei.toString() },
      outputToken: tokenOut,
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) {
      return fail("Pendle returned no route for this trade.");
    }
    const best = response.routes[0]!;
    const action = response.action === "redeem-py" ? "redeem" : "swap";
    const direction: "buy" | "sell" | "redeem" = action === "redeem" ? "redeem" : ptIsOut ? "buy" : "sell";

    const assetMap = await buildAssetMap(chainId);
    const outAmount = best.outputs[0]?.amount ?? "0";
    const outDecimals = assetMap.get(tokenOut.toLowerCase())?.decimals ?? null;

    // Echo EXACTLY the fields the recorder + extractPendleQuote validate. `chainId`
    // is the RESOLVED chain (the prequote identity binds it). `receiver` is the
    // resolved wallet (self); the redeem identity re-derives it identically.
    return ok({
      action,
      direction,
      chainId,
      tokenIn: { address: tokenIn.address, isNative: tokenIn.isNative },
      tokenOut: { address: tokenOut },
      pt: ptAddress,
      yt: market?.yt ?? null,
      market: market?.address ?? null,
      receiver,
      expiry: market?.expiry ?? null,
      liquidityUsd: market?.details.liquidity ?? null,
      priceImpact: best.data.priceImpact,
      feeUsdEstimate: best.data.feeUsd,
      amountIn: amountInRaw,
      amountOut: humanAmount(outAmount, outDecimals).toString(),
      aggregator: best.data.aggregatorType,
      slippageBps: num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS,
    });
  } catch (err) {
    return fail(`Pendle quote unavailable (${failureDetail("pendle.pt.quote", err)})`);
  }
}

// ── Buy / Sell (token↔PT swap) ───────────────────────────────────────

async function executePendleSwap(
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
      return refuse("route_not_found", "Pendle did not return a swap route — a matured PT can only be redeemed (use pendle.pt.redeem).");
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
    const outUsd = legUsd(assetMap, tokenOut, executedOutHuman);
    const executedInUsd = legUsd(assetMap, tokenIn.address, executedInHuman);
    const inputValueUsd = executedInUsd ?? outUsd ?? 0;
    const outputValueUsd = outUsd ?? executedInUsd ?? 0;

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
        _tradeCapture: {
          type: "swap",
          chain: chainSlug, // resolves selective balance sync to the traded chain
          status: "executed",
          inputToken: tokenIn.isNative ? chainEntry.nativeSymbol : tokenIn.address,
          outputToken: tokenOut,
          inputTokenAddress: tokenIn.address,
          outputTokenAddress: tokenOut,
          // RAW base-unit strings (Codex fix): the spot lot projector BigInt()s
          // these — human decimals would throw / corrupt lot quantities. The
          // human-readable amounts live only in the model-facing output above.
          // These are the DECODED amounts: a lot opened at a quoted size that
          // never arrived is a wrong lot forever.
          inputAmount: executedInRaw,
          outputAmount: executedOutRaw,
          inputValueUsd: String(inputValueUsd),
          outputValueUsd: String(outputValueUsd),
          valuationSource: "pendle",
          signature: txHash,
          walletAddress: wallet,
          tradeSide: side,
          instrumentKey: `${chainSlug}:${ptAddress.toLowerCase()}`,
          settlementAssetKey: side === "buy" ? (tokenIn.isNative ? chainEntry.nativeSymbol : tokenIn.address) : tokenOut,
          meta: {
            protocol: "pendle",
            side,
            pendle: {
              marketAddress: market.address,
              ptAddress,
              ytAddress: market.yt,
              syAddress: market.sy,
              underlyingAsset: market.underlyingAsset,
              expiry: market.expiry,
              ptSymbol: assetMap.get(ptAddress.toLowerCase())?.symbol ?? null,
              ptDecimals: assetMap.get(ptAddress.toLowerCase())?.decimals ?? null,
            },
          },
        },
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure(`pendle.pt.${side}`, txHash, err);
    return fail(`Pendle ${side} failed (${failureDetail(`pendle.pt.${side}`, err)})`);
  }
}

// ── Redeem (matured PT → accounting asset) ───────────────────────────

async function executePendleRedeem(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !amountInRaw) return fail("Missing required: chain, tokenIn (PT), amountIn");
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`). BOTH
  // redeem paths broadcast — the Convert path and the `redeemPyToSy` fallback —
  // and each is followed by a read-back that can throw. Declaring this inside
  // the `try` (as it was) put the hash out of the catch's reach.
  let txHash: Hex | undefined;
  const toolId = "pendle.pt.redeem";
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);
    // PT decimals read ON-CHAIN (unified with the swap input path) — NEVER from the
    // global asset map: a cross-chain address collision there would feed parseUnits
    // and corrupt a real broadcast amount. resolveInputToken reads decimals from the
    // resolved chain's client (a PT is a plain ERC-20, never native).
    const ptToken = await resolveInputToken(chainEntry, tokenInRaw);
    const ptAddress = ptToken.address;
    const ptDecimals = ptToken.decimals;
    // EXIT PATH (R5b): the whole point of redeem is a MATURED PT, which the
    // active-only resolver could never see (G-02/D18 — the position the tool
    // exists for was unreachable by the tool). An inactive row is believed only
    // on a parseable, past expiry; anything else is refused by name inside the
    // resolver.
    const resolved = await resolveExitMarketByPt(chainId, ptAddress);
    const market = resolved?.market ?? null;
    if (!market || !market.yt || !market.underlyingAsset) {
      const reason = "No Pendle market for this PT — cannot resolve YT/underlying for redeem. Check pendle.market.get, which reads matured markets too.";
      await recordPendleRefusal(
        {
          toolId, eventRole: "yield_pt", chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p, tokenIn: { tokenAddress: ptAddress, tokenDecimals: ptDecimals },
        },
        "route_not_found",
        reason,
      );
      return fail(reason);
    }
    const expectedYt = getAddress(market.yt);
    const outputToken = getAddress(market.underlyingAsset);
    // Asset map stays ONLY for USD valuation/symbols, chain-scoped.
    const assetMapPre = await buildAssetMap(chainId);
    const amountWei = parseUnits(amountInRaw, ptDecimals);

    if (p.dryRun === true) {
      return ok({ dryRun: true, action: "redeem", pt: ptAddress, yt: expectedYt, outputToken });
    }

    let signer: ChainWallet;
    try {
      signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
    const wallet = getAddress(signer.address);
    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    const slippage = resolvePendleSlippage("pendle.pt.redeem", num(p, "slippageBps"));

    let outHuman = 0;
    /** What the Convert route ADVERTISED — reported beside the fill, never as it. */
    let quotedOutHuman = 0;
    /** RAW base-unit output amount for the capture — the DECODED credit. */
    let outAmountRaw = "0";
    let usedFallback = false;
    let outUsd: number | null = null;
    /**
     * WHICH ASSET THE WALLET ACTUALLY RECEIVES (P1-13). The two redeem paths
     * deliver DIFFERENT tokens: Convert's `redeemPyToToken` pays the market's
     * underlying, while the `redeemPyToSy` fallback pays SY. The capture used to
     * record `underlyingAsset` for BOTH, so a fallback redeem booked an asset the
     * wallet does not hold — with amount "0" and the full input USD attached to
     * it. Same tool, same params, a different asset, and nothing in the record
     * said so.
     */
    let deliveredAsset: Address = outputToken;
    let deliveredPath: "convert" | "router_fallback_redeemPyToSy" = "convert";

    // Primary path: Convert (action redeem-py) + full fund-safety validation.
    let response: PendleConvertResponse | null = null;
    try {
      response = await getPendleClient().convert(chainId, {
        receiver: wallet,
        input: { token: ptAddress, amount: amountWei.toString() },
        outputToken,
        slippage: slippage.fraction,
      });
    } catch (err) {
      logger.warn("pendle.redeem.convert_failed_fallback", { code: err instanceof VexError ? err.code : "UNEXPECTED" });
    }

    /**
     * The durable row's OUT leg and the decoder's OUT token must name the SAME
     * asset. The two redeem paths deliver DIFFERENT tokens, so both are decided
     * before either branch signs, and the Convert branch overwrites nothing.
     */
    let broadcast: Awaited<ReturnType<typeof sendPendleRouterTx>>;
    const inLeg = legInput(ptAddress, assetMapPre.get(ptAddress.toLowerCase())?.symbol, ptDecimals, amountWei.toString(), humanAmount(amountWei, ptDecimals).toString());

    if (response && response.action === "redeem-py") {
      const intent: PendleTxIntent = {
        action: "redeem",
        wallet,
        // The tolerance this route is held to — see calldata/price-floor.ts.
        slippageBps: slippage.bps,
        inputToken: ptAddress,
        inputAmountWei: amountWei,
        isNative: false,
        expectedYt,
        ptAddress,
        // Bind the decoded TokenOutput.tokenOut to the quoted accounting asset.
        expectedOutputToken: outputToken,
      };
      const route = selectSafeRoute(intent, response);
      // Approve EXACTLY the required set (Convert asks YT + PT), each to the Router.
      for (const approval of response.requiredApprovals) {
        await ensurePendleAllowanceExact(publicClient, walletClient, getAddress(approval.token), PENDLE_ROUTER, BigInt(approval.amount));
      }
      const quotedOutRaw = route.outputs[0]?.amount ?? "0";
      const outDecimals = assetMapPre.get(outputToken.toLowerCase())?.decimals ?? null;
      quotedOutHuman = humanAmount(quotedOutRaw, outDecimals);
      broadcast = await sendPendleRouterTx(
        publicClient,
        walletClient,
        { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
        {
          toolId, eventRole: "yield_pt", chainId, chainSlug, walletAddress: wallet, sessionId,
          intentParams: p,
          tokenIn: inLeg,
          tokenOut: legInput(outputToken, assetMapPre.get(outputToken.toLowerCase())?.symbol, outDecimals, quotedOutRaw, quotedOutHuman.toString()),
          routeProvenance: { deliveredPath: "convert", aggregator: route.data.aggregatorType, pendle: { syAddress: market.sy } },
        },
      );
      txHash = broadcast.txHash;
      if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);
      outAmountRaw = broadcast.executed.amountOutRaw ?? "0";
      outHuman = humanAmount(outAmountRaw, outDecimals);
      outUsd = legUsd(assetMapPre, outputToken, outHuman);
    } else {
      // API-independent fallback (matured PT only): redeemPyToSy on the pinned Router.
      // GATE FIRST (P1-14): this branch is reached for ANY non-`redeem-py` answer,
      // including a healthy `"swap"` and any transport failure, and redeemPyToSy
      // burns PT alone — which pre-expiry MUST revert. Refuse by name instead of
      // approving the PT and broadcasting a doomed call.
      assertPtMaturedForFallback(market.expiry);
      usedFallback = true;
      // The fallback delivers SY, not the underlying. Record what actually
      // arrives; if the market publishes no SY we have no honest asset to name,
      // so the redeem is refused rather than booked against the wrong token.
      if (!market.sy) {
        return fail("Pendle did not report this market's SY, so a direct redeem could not be recorded honestly. Retry, or use pendle.market.get to confirm the market.");
      }
      deliveredAsset = getAddress(market.sy);
      deliveredPath = "router_fallback_redeemPyToSy";
      const plan = buildRedeemPyToSyPlan({ receiver: wallet, yt: expectedYt, netPyIn: amountWei, slippage: slippage.fraction });
      await ensurePendleAllowanceExact(publicClient, walletClient, ptAddress, PENDLE_ROUTER, amountWei);
      const syDecimals = assetMapPre.get(deliveredAsset.toLowerCase())?.decimals ?? null;
      broadcast = await sendPendleRouterTx(
        publicClient,
        walletClient,
        { to: plan.to, data: plan.data, value: 0n },
        {
          toolId, eventRole: "yield_pt", chainId, chainSlug, walletAddress: wallet, sessionId,
          intentParams: p,
          tokenIn: inLeg,
          // NO quoted amount: this path has no quote at all. The leg names the
          // asset (SY) so the decoder can prove the credit; a floor is not a
          // fill, so nothing is stated until the receipt says so.
          tokenOut: { tokenAddress: deliveredAsset, ...(syDecimals !== null ? { tokenDecimals: syDecimals } : {}) },
          // The discriminant the decoder needs: this path pays SY, not the
          // market's underlying, so it must match the OUT leg against SY.
          routeProvenance: { deliveredPath, syAddress: market.sy },
        },
      );
      txHash = broadcast.txHash;
      if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);
      // The fallback now HAS a measured output — the decoded SY credit.
      outAmountRaw = broadcast.executed.amountOutRaw ?? "0";
      outHuman = humanAmount(outAmountRaw, syDecimals);
      outUsd = legUsd(assetMapPre, deliveredAsset, outHuman);
    }

    // Valuation — PT redeems ~1:1 to its accounting value; use price.acc for the PT.
    const ptAcc = assetMapPre.get(ptAddress.toLowerCase())?.priceAcc ?? assetMapPre.get(ptAddress.toLowerCase())?.priceUsd ?? null;
    const inHuman = humanAmount(amountWei, ptDecimals);
    const inputValueUsd = ptAcc !== null ? inHuman * ptAcc : (outUsd ?? 0);
    // Both paths now carry a DECODED output (the receipt's net wallet credit),
    // so the fallback no longer has to record 0 for an amount it could not
    // measure — the previous honest-but-blind shape. `outUsd` prices that
    // decoded amount; a null price still refuses to carry the input's USD
    // across to an output nobody valued.
    const outputValueUsd = outUsd ?? (usedFallback ? 0 : inputValueUsd);
    const deliveredNote = usedFallback
      ? "Redeemed via the Router fallback, which pays SY — NOT the market's underlying. The amount is the SY credit decoded from the receipt. Unwrapping SY to the underlying needs pendle.sy.redeem, which does not exist yet."
      : null;

    logger.info("pendle.pt.redeem.executed", { pt: ptAddress, fallback: usedFallback });

    return {
      success: true,
      output: JSON.stringify({
        txHash, action: "redeem", pt: ptAddress, fallback: usedFallback, amountIn: amountInRaw,
        executedAmountOut: outHuman.toString(),
        // Only the Convert path had a quote to compare the fill against.
        ...(usedFallback ? {} : { quotedAmountOut: quotedOutHuman.toString() }),
        // The discriminant an agent needs to know WHAT it now holds (P1-13).
        deliveredAsset, deliveredAssetKind: usedFallback ? "sy" : "underlying", deliveredPath,
        ...(deliveredNote ? { note: deliveredNote } : {}),
      }, null, 2),
      data: {
        txHash,
        _executionId: broadcast.executionId,
        _tradeCapture: {
          type: "swap",
          chain: chainSlug,
          status: "closed",
          inputToken: ptAddress,
          outputToken: deliveredAsset,
          inputTokenAddress: ptAddress,
          outputTokenAddress: deliveredAsset,
          // RAW base-unit strings (Codex fix) — the spot projector BigInt()s these.
          inputAmount: amountWei.toString(),
          outputAmount: outAmountRaw,
          inputValueUsd: String(inputValueUsd),
          outputValueUsd: String(outputValueUsd),
          valuationSource: "pendle",
          signature: txHash,
          walletAddress: wallet,
          tradeSide: "sell",
          instrumentKey: `${chainSlug}:${ptAddress.toLowerCase()}`,
          settlementAssetKey: deliveredAsset,
          meta: {
            protocol: "pendle",
            side: "redeem",
            usedFallback,
            deliveredPath,
            deliveredAssetKind: usedFallback ? "sy" : "underlying",
            ...(deliveredNote ? { deliveredNote } : {}),
            pendle: {
              marketAddress: market.address,
              ptAddress,
              ytAddress: market.yt,
              syAddress: market.sy,
              underlyingAsset: market.underlyingAsset,
              expiry: market.expiry,
              ptSymbol: assetMapPre.get(ptAddress.toLowerCase())?.symbol ?? null,
              ptDecimals,
            },
          },
        },
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.pt.redeem", txHash, err);
    return fail(`Pendle redeem failed (${failureDetail("pendle.pt.redeem", err)})`);
  }
}

export const PENDLE_PT_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.pt.quote": (p, ctx) => pendlePtQuote(p, ctx),
  "pendle.pt.buy": (p, ctx) => executePendleSwap(p, "buy", ctx),
  "pendle.pt.sell": (p, ctx) => executePendleSwap(p, "sell", ctx),
  "pendle.pt.redeem": (p, ctx) => executePendleRedeem(p, ctx),
};
