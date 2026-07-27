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

import { getAddress, parseUnits, type Hex } from "viem";

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
import { selectSafeRoute, type PendleAction, type PendleTxIntent } from "../calldata.js";
import { buildRedeemPyToSyPlan } from "../redeem-fallback.js";
import { broadcastUnconfirmedFailure } from "./broadcast-unconfirmed.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  failureDetail,
  humanAmount,
  legUsd,
  requirePendleChain,
  requireTokenAddress,
  resolveInputToken,
  slippageFraction,
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
    const marketByOut = await resolveMarketByPt(chainId, tokenOut);
    const marketByIn = await resolveMarketByPt(chainId, tokenIn.address);
    if (!marketByOut && !marketByIn) {
      return fail("Neither token is an active Pendle PT on this chain — find the PT via pendle.yields, or use pendle.yt.quote for YT trades.");
    }
    const ptIsOut = marketByOut !== null;
    const ptAddress = ptIsOut ? tokenOut : tokenIn.address;
    const market = ptIsOut ? marketByOut : marketByIn;

    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = slippageFraction(num(p, "slippageBps"));

    const client = getPendleClient();
    const response = await client.convert(chainId, {
      receiver,
      input: { token: tokenIn.address, amount: amountWei.toString() },
      outputToken: tokenOut,
      slippage,
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
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    const tokenOut = requireTokenAddress(tokenOutRaw);
    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = slippageFraction(num(p, "slippageBps"));

    // PT + canonical market — buy: PT is tokenOut; sell: PT is tokenIn.
    const ptAddress = side === "buy" ? tokenOut : tokenIn.address;
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.address) {
      return fail("No active Pendle market for this PT — check pendle.yields.");
    }
    const expectedMarket = getAddress(market.address);

    if (p.dryRun === true) {
      const response = await getPendleClient().convert(chainId, {
        receiver: PENDLE_ROUTER, // placeholder — dry-run never signs
        input: { token: tokenIn.address, amount: amountWei.toString() },
        outputToken: tokenOut,
        slippage,
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
      slippage,
    });
    if (!response) return fail("Pendle returned no route for this trade.");
    if (response.action !== "swap") {
      return fail("Pendle did not return a swap route — a matured PT can only be redeemed (use pendle.pt.redeem).");
    }

    const intent: PendleTxIntent = {
      action: side as PendleAction,
      wallet,
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
    txHash = await walletClient.sendTransaction({
      account: walletClient.account,
      chain: walletClient.chain,
      to: getAddress(route.tx.to),
      data: route.tx.data as Hex,
      value,
    });

    // Exact USD valuation from Pendle prices (valuationSource "pendle").
    const assetMap = await buildAssetMap(chainId);
    const outAmount = route.outputs[0]?.amount ?? "0";
    const outDecimals = assetMap.get(tokenOut.toLowerCase())?.decimals ?? null;
    const inHuman = humanAmount(amountWei, tokenIn.decimals);
    const outHuman = humanAmount(outAmount, outDecimals);
    const inUsd = legUsd(assetMap, tokenIn.address, inHuman);
    const outUsd = legUsd(assetMap, tokenOut, outHuman);
    const inputValueUsd = inUsd ?? outUsd ?? 0;
    const outputValueUsd = outUsd ?? inUsd ?? 0;

    logger.info("pendle.pt.swap.executed", { side, market: expectedMarket, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({ txHash, side, market: expectedMarket, tokenIn: tokenIn.address, tokenOut, amountIn: amountInRaw, amountOut: outHuman.toString() }, null, 2),
      data: {
        txHash,
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
          inputAmount: amountWei.toString(),
          outputAmount: outAmount,
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
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    // PT decimals read ON-CHAIN (unified with the swap input path) — NEVER from the
    // global asset map: a cross-chain address collision there would feed parseUnits
    // and corrupt a real broadcast amount. resolveInputToken reads decimals from the
    // resolved chain's client (a PT is a plain ERC-20, never native).
    const ptToken = await resolveInputToken(chainEntry, tokenInRaw);
    const ptAddress = ptToken.address;
    const ptDecimals = ptToken.decimals;
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.underlyingAsset) {
      return fail("No active Pendle market for this PT — cannot resolve YT/underlying for redeem.");
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
    const slippage = slippageFraction(num(p, "slippageBps"));

    let outHuman = 0;
    /** RAW base-unit output amount for the capture ("0" when unknown — fallback). */
    let outAmountRaw = "0";
    let usedFallback = false;
    let outUsd: number | null = null;

    // Primary path: Convert (action redeem-py) + full fund-safety validation.
    let response: PendleConvertResponse | null = null;
    try {
      response = await getPendleClient().convert(chainId, {
        receiver: wallet,
        input: { token: ptAddress, amount: amountWei.toString() },
        outputToken,
        slippage,
      });
    } catch (err) {
      logger.warn("pendle.redeem.convert_failed_fallback", { code: err instanceof VexError ? err.code : "UNEXPECTED" });
    }

    if (response && response.action === "redeem-py") {
      const intent: PendleTxIntent = {
        action: "redeem",
        wallet,
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
      txHash = await walletClient.sendTransaction({
        account: walletClient.account,
        chain: walletClient.chain,
        to: getAddress(route.tx.to),
        data: route.tx.data as Hex,
        value: 0n,
      });
      const assetMap = await buildAssetMap(chainId);
      outAmountRaw = route.outputs[0]?.amount ?? "0";
      const outDecimals = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
      outHuman = humanAmount(outAmountRaw, outDecimals);
      outUsd = legUsd(assetMap, outputToken, outHuman);
    } else {
      // API-independent fallback (matured PT only): redeemPyToSy on the pinned Router.
      usedFallback = true;
      const plan = buildRedeemPyToSyPlan({ receiver: wallet, yt: expectedYt, netPyIn: amountWei, slippage });
      await ensurePendleAllowanceExact(publicClient, walletClient, ptAddress, PENDLE_ROUTER, amountWei);
      txHash = await walletClient.sendTransaction({
        account: walletClient.account,
        chain: walletClient.chain,
        to: plan.to,
        data: plan.data,
        value: 0n,
      });
    }

    // Valuation — PT redeems ~1:1 to its accounting value; use price.acc for the PT.
    const ptAcc = assetMapPre.get(ptAddress.toLowerCase())?.priceAcc ?? assetMapPre.get(ptAddress.toLowerCase())?.priceUsd ?? null;
    const inHuman = humanAmount(amountWei, ptDecimals);
    const inputValueUsd = ptAcc !== null ? inHuman * ptAcc : (outUsd ?? 0);
    const outputValueUsd = outUsd ?? inputValueUsd;

    logger.info("pendle.pt.redeem.executed", { pt: ptAddress, fallback: usedFallback });

    return {
      success: true,
      output: JSON.stringify({ txHash, action: "redeem", pt: ptAddress, fallback: usedFallback, amountIn: amountInRaw }, null, 2),
      data: {
        txHash,
        _tradeCapture: {
          type: "swap",
          chain: chainSlug,
          status: "closed",
          inputToken: ptAddress,
          outputToken,
          inputTokenAddress: ptAddress,
          outputTokenAddress: outputToken,
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
          settlementAssetKey: outputToken,
          meta: {
            protocol: "pendle",
            side: "redeem",
            usedFallback,
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
