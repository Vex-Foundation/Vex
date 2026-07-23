/**
 * Pendle PY handlers — quote (read) + mint / pre-expiry redeem (mutating).
 *
 * PY = the PT+YT pair. `pendle.py.mint` splits ONE payment token into an EQUAL
 * amount of PT and YT in a single transaction (Convert action `mint-py`,
 * `mintPyFromToken`). `pendle.py.redeem` burns an EQUAL PT+YT pair back to a token
 * BEFORE expiry (Convert action `redeem-py`, `redeemPyToToken`) — distinct from
 * `pendle.pt.redeem`, which redeems a MATURED PT (PT only, no YT).
 *
 * Both mutating paths mirror the PT/YT discipline: fresh Convert re-fetch →
 * `selectSafeRoute` fund-safety extractor (Router pin, receiver == wallet, YT ==
 * quoted, exact spend, EXACT approval set) → exact allowance(s) to the pinned
 * Router → broadcast. They are approval-gated + prequote-gated (mint → kind
 * `mint`; redeem → kind `redeem_py`).
 *
 * Capture: ONE execution, TWO capture items (a PT leg + a YT leg) with DISTINCT
 * instrument keys, so the portfolio ledger opens/closes the PT lot and the YT lot
 * separately. Amounts are RAW base-unit strings; the input (mint) / output
 * (redeem) token and its USD value are split across the two legs proportionally to
 * each leg's USD (50/50 fallback when a leg is unpriced). Upstream error text NEVER
 * reaches the model.
 */

import { getAddress, parseUnits, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import type { PendleConvertResponse, PendleTokenAmount } from "@tools/pendle/types.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

import { resolveMarketByPt, buildAssetMap, priceUsdFor } from "../market-lookup.js";
import { selectSafeRoute, type PendleTxIntent } from "../calldata.js";
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

// ── Split helpers ────────────────────────────────────────────────────

/**
 * PT's share of a two-leg value split. When BOTH legs are priced, split by USD;
 * otherwise a 50/50 fallback (documented — a mint/redeem is roughly balanced, and
 * an unpriced leg gives no better estimate). Always in [0, 1].
 */
function ptUsdShare(ptUsd: number | null, ytUsd: number | null): number {
  if (ptUsd !== null && ytUsd !== null && ptUsd + ytUsd > 0) {
    const s = ptUsd / (ptUsd + ytUsd);
    return Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0.5;
  }
  return 0.5;
}

/** Split a raw base-unit total into [pt, yt] by `ptShare`, conserving the total. */
function splitWei(total: bigint, ptShare: number): [bigint, bigint] {
  const SCALE = 1_000_000n;
  const ptScaled = BigInt(Math.min(1_000_000, Math.max(0, Math.round(ptShare * 1_000_000))));
  const ptPart = (total * ptScaled) / SCALE;
  return [ptPart, total - ptPart];
}

/** Find a Convert route output amount (raw) for `address`; "0" when absent. */
function outputAmountFor(outputs: readonly PendleTokenAmount[], address: string): string {
  const lower = address.toLowerCase();
  return outputs.find((o) => o.token.toLowerCase() === lower)?.amount ?? "0";
}

// ── Quote ────────────────────────────────────────────────────────────

async function pendlePyQuote(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), direction = str(p, "direction"), ptRaw = str(p, "pt"), amountInRaw = str(p, "amountIn");
  if (!chain || !ptRaw || !amountInRaw) return fail("Missing required: chain, pt, amountIn");
  if (direction !== "mint" && direction !== "redeem") {
    return fail("direction must be 'mint' (token → PT+YT) or 'redeem' (pre-expiry PT+YT → token).");
  }
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const receiver = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
    const ptAddress = requireTokenAddress(ptRaw);

    // INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): the `pt` must be an
    // active PT on the resolved chain (mirrors the P3-fixed quotes). A quote with
    // no PT anchor must never record a PY identity that could authorize an execute
    // on the wrong instrument.
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.address) {
      return fail("`pt` is not an active Pendle PT on this chain — find the PT via pendle.yields.");
    }
    const ytAddress = getAddress(market.yt);
    const slippage = slippageFraction(num(p, "slippageBps"));
    const client = getPendleClient();
    const assetMap = await buildAssetMap(chainId);
    const slippageBpsEcho = num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;

    if (direction === "mint") {
      const tokenIn = await resolveInputToken(chainEntry, str(p, "tokenIn"));
      const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
      const response = await client.convertMulti(chainId, {
        receiver,
        inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
        outputs: [ptAddress, ytAddress],
        slippage,
      });
      if (!response || response.routes.length === 0) return fail("Pendle returned no mint route for these tokens.");
      if (response.action !== "mint-py") {
        return fail("Pendle did not return a mint route — for a plain PT buy use pendle.pt.buy, or a YT buy use pendle.yt.buy.");
      }
      const best = response.routes[0]!;
      const ptOut = outputAmountFor(best.outputs, ptAddress);
      const ytOut = outputAmountFor(best.outputs, ytAddress);
      const ptDec = assetMap.get(ptAddress.toLowerCase())?.decimals ?? null;
      const ytDec = assetMap.get(ytAddress.toLowerCase())?.decimals ?? null;
      // Echo EXACTLY the fields `extractPendlePyQuote` validates. `chainId` is the
      // RESOLVED chain; tokenIn = payment token, tokenOut = the PT anchor.
      return ok({
        action: "mint-py",
        direction: "mint",
        chainId,
        tokenIn: { address: tokenIn.address, isNative: tokenIn.isNative },
        tokenOut: { address: ptAddress },
        pt: ptAddress,
        yt: ytAddress,
        market: market.address,
        receiver,
        expiry: market.expiry ?? null,
        liquidityUsd: market.details.liquidity ?? null,
        priceImpact: best.data.priceImpact,
        amountIn: amountInRaw,
        ptOut: humanAmount(ptOut, ptDec).toString(),
        ytOut: humanAmount(ytOut, ytDec).toString(),
        aggregator: best.data.aggregatorType,
        slippageBps: slippageBpsEcho,
      });
    }

    // direction === "redeem" (pre-expiry PT+YT → token).
    const ptToken = await resolveInputToken(chainEntry, ptRaw);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return fail("No output token — pass tokenOut (the market has no underlying to default to).");
    const amountWei = parseUnits(amountInRaw, ptToken.decimals);
    const response = await client.convertMulti(chainId, {
      receiver,
      inputs: [
        { token: ptAddress, amount: amountWei.toString() },
        { token: ytAddress, amount: amountWei.toString() },
      ],
      outputs: [outputToken],
      slippage,
    });
    if (!response || response.routes.length === 0) return fail("Pendle returned no pre-expiry redeem route.");
    if (response.action !== "redeem-py") {
      return fail("Pendle did not return a pre-expiry redeem route — a MATURED PT (PT only) uses pendle.pt.redeem.");
    }
    const best = response.routes[0]!;
    const outAmount = best.outputs[0]?.amount ?? "0";
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    return ok({
      action: "redeem-py",
      direction: "redeem",
      chainId,
      tokenIn: { address: ptAddress },
      tokenOut: { address: outputToken },
      pt: ptAddress,
      yt: ytAddress,
      market: market.address,
      receiver,
      expiry: market.expiry ?? null,
      liquidityUsd: market.details.liquidity ?? null,
      priceImpact: best.data.priceImpact,
      amountIn: amountInRaw,
      amountOut: humanAmount(outAmount, outDec).toString(),
      aggregator: best.data.aggregatorType,
      slippageBps: slippageBpsEcho,
    });
  } catch (err) {
    return fail(`Pendle PY quote unavailable (${failureDetail("pendle.py.quote", err)})`);
  }
}

// ── Mint (token → PT+YT) ─────────────────────────────────────────────

async function executePendleMint(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), ptRaw = str(p, "pt"), tokenInRaw = str(p, "tokenIn"), amountInRaw = str(p, "amountIn");
  if (!chain || !ptRaw || !tokenInRaw || !amountInRaw) {
    return fail("Missing required: chain, pt, tokenIn, amountIn");
  }
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const ptAddress = requireTokenAddress(ptRaw);
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.address) {
      return fail("No active Pendle market for this PT — check pendle.yields.");
    }
    const ytAddress = getAddress(market.yt);
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = slippageFraction(num(p, "slippageBps"));

    if (p.dryRun === true) {
      const response = await getPendleClient().convertMulti(chainId, {
        receiver: PENDLE_ROUTER, // placeholder — dry-run never signs
        inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
        outputs: [ptAddress, ytAddress],
        slippage,
      });
      const best = response?.routes[0];
      return ok({ dryRun: true, action: "mint", pt: ptAddress, yt: ytAddress, market: market.address, aggregator: best?.data.aggregatorType ?? null, priceImpact: best?.data.priceImpact ?? null });
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

    const response = await getPendleClient().convertMulti(chainId, {
      receiver: wallet,
      inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
      outputs: [ptAddress, ytAddress],
      slippage,
    });
    if (!response) return fail("Pendle returned no mint route for these tokens.");
    if (response.action !== "mint-py") {
      return fail("Pendle did not return a mint route — for a plain PT buy use pendle.pt.buy.");
    }

    const intent: PendleTxIntent = {
      action: "py-mint",
      wallet,
      inputToken: tokenIn.address,
      inputAmountWei: amountWei,
      isNative: tokenIn.isNative,
      // mintPyFromToken carries the YT at arg 1 — bind it to the quoted market's YT.
      expectedYt: ytAddress,
      ptAddress: getAddress(ptAddress),
    };
    const route = selectSafeRoute(intent, response);

    // Approve EXACTLY the input token (native needs none; native is rejected
    // upstream anyway). Spender is the pinned Router.
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
    const txHash = await walletClient.sendTransaction({
      account: walletClient.account,
      chain: walletClient.chain,
      to: getAddress(route.tx.to),
      data: route.tx.data as Hex,
      value: tokenIn.isNative ? amountWei : 0n,
    });

    const assetMap = await buildAssetMap(chainId);
    const ptOut = outputAmountFor(route.outputs, ptAddress);
    const ytOut = outputAmountFor(route.outputs, ytAddress);
    const ptDec = assetMap.get(ptAddress.toLowerCase())?.decimals ?? null;
    const ytDec = assetMap.get(ytAddress.toLowerCase())?.decimals ?? null;
    const ptPrice = priceUsdFor(assetMap, ptAddress);
    const ytPrice = priceUsdFor(assetMap, ytAddress);
    const ptOutUsd = ptPrice !== null ? humanAmount(ptOut, ptDec) * ptPrice : null;
    const ytOutUsd = ytPrice !== null ? humanAmount(ytOut, ytDec) * ytPrice : null;
    const share = ptUsdShare(ptOutUsd, ytOutUsd);
    const [ptInWei, ytInWei] = splitWei(amountWei, share);
    // Total paid value from the payment leg (which almost always has a price);
    // fall back to the summed leg USD when the payment token is unpriced.
    const inTotalUsd = legUsd(assetMap, tokenIn.address, humanAmount(amountWei, tokenIn.decimals)) ?? ((ptOutUsd ?? 0) + (ytOutUsd ?? 0));
    const ptInUsd = inTotalUsd * share;
    const ytInUsd = inTotalUsd * (1 - share);

    const pendleMeta = {
      marketAddress: market.address,
      ptAddress,
      ytAddress: market.yt,
      syAddress: market.sy,
      underlyingAsset: market.underlyingAsset,
      expiry: market.expiry,
    };
    const legItem = (
      leg: "pt" | "yt",
      instrument: string,
      inWei: bigint,
      outRaw: string,
      inUsd: number,
      outUsd: number | null,
    ): Record<string, unknown> => ({
      type: "swap",
      chain: chainSlug,
      status: "executed",
      inputToken: tokenIn.address,
      outputToken: instrument,
      inputTokenAddress: tokenIn.address,
      outputTokenAddress: instrument,
      // RAW base-unit strings — the spot lot projector BigInt()s these.
      inputAmount: inWei.toString(),
      outputAmount: outRaw,
      inputValueUsd: String(inUsd),
      outputValueUsd: String(outUsd ?? inUsd),
      valuationSource: "pendle",
      signature: txHash,
      walletAddress: wallet,
      tradeSide: "buy",
      // DISTINCT lot keys — the PT lot and the YT lot are separate instruments.
      instrumentKey: `${chainSlug}:${instrument.toLowerCase()}`,
      settlementAssetKey: tokenIn.address,
      meta: { protocol: "pendle", side: "mint", leg, pendle: pendleMeta },
    });

    logger.info("pendle.py.mint.executed", { market: market.address, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({ txHash, action: "mint", pt: ptAddress, yt: ytAddress, market: market.address, amountIn: amountInRaw, ptOut: humanAmount(ptOut, ptDec).toString(), ytOut: humanAmount(ytOut, ytDec).toString() }, null, 2),
      data: {
        txHash,
        // Audit-record summary (NOT projected — the fanOut:"items" strictItemsRequired
        // guard uses the items below for projection). Represents the whole mint.
        _tradeCapture: {
          type: "swap",
          chain: chainSlug,
          status: "executed",
          walletAddress: wallet,
          tradeSide: "buy",
          instrumentKey: `${chainSlug}:${ptAddress.toLowerCase()}`,
          inputTokenAddress: tokenIn.address,
          outputTokenAddress: ptAddress,
          inputAmount: amountWei.toString(),
          outputAmount: ptOut,
          inputValueUsd: String(inTotalUsd),
          outputValueUsd: String(inTotalUsd),
          valuationSource: "pendle",
          signature: txHash,
          settlementAssetKey: tokenIn.address,
          meta: { protocol: "pendle", side: "mint", pendle: pendleMeta },
        },
        _tradeCaptureItems: [
          legItem("pt", ptAddress, ptInWei, ptOut, ptInUsd, ptOutUsd),
          legItem("yt", ytAddress, ytInWei, ytOut, ytInUsd, ytOutUsd),
        ],
      },
    };
  } catch (err) {
    return fail(`Pendle mint failed (${failureDetail("pendle.py.mint", err)})`);
  }
}

// ── Redeem (pre-expiry PT+YT → token) ────────────────────────────────

async function executePendleRedeemPy(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), ptRaw = str(p, "pt"), amountInRaw = str(p, "amountIn");
  if (!chain || !ptRaw || !amountInRaw) return fail("Missing required: chain, pt, amountIn");
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const ptAddress = requireTokenAddress(ptRaw);
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.address) {
      return fail("No active Pendle market for this PT — a MATURED PT uses pendle.pt.redeem.");
    }
    const ytAddress = getAddress(market.yt);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return fail("No output token — pass tokenOut (the market has no underlying to default to).");
    // PT decimals read ON-CHAIN (a PT is a plain ERC-20). PT and YT are minted 1:1
    // and share decimals, so the equal-leg burn amount uses the same wei.
    const ptToken = await resolveInputToken(chainEntry, ptRaw);
    const amountWei = parseUnits(amountInRaw, ptToken.decimals);
    const slippage = slippageFraction(num(p, "slippageBps"));

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
      slippage,
    });
    if (!response) return fail("Pendle returned no pre-expiry redeem route.");
    if (response.action !== "redeem-py") {
      return fail("Pendle did not return a pre-expiry redeem route — a MATURED PT uses pendle.pt.redeem.");
    }

    const intent: PendleTxIntent = {
      action: "py-redeem",
      wallet,
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
    const txHash = await walletClient.sendTransaction({
      account: walletClient.account,
      chain: walletClient.chain,
      to: getAddress(route.tx.to),
      data: route.tx.data as Hex,
      value: 0n,
    });

    const assetMap = await buildAssetMap(chainId);
    const outAmount = route.outputs[0]?.amount ?? "0";
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    const ptPrice = priceUsdFor(assetMap, ptAddress);
    const ytPrice = priceUsdFor(assetMap, ytAddress);
    const ptDec = assetMap.get(ptAddress.toLowerCase())?.decimals ?? ptToken.decimals;
    const ytDec = assetMap.get(ytAddress.toLowerCase())?.decimals ?? ptToken.decimals;
    const ptInUsd = ptPrice !== null ? humanAmount(amountWei, ptDec) * ptPrice : null;
    const ytInUsd = ytPrice !== null ? humanAmount(amountWei, ytDec) * ytPrice : null;
    const share = ptUsdShare(ptInUsd, ytInUsd);
    const outTotalUsd = legUsd(assetMap, outputToken, humanAmount(outAmount, outDec)) ?? ((ptInUsd ?? 0) + (ytInUsd ?? 0));
    const [ptOutWei, ytOutWei] = splitWei(BigInt(outAmount), share);
    const ptOutUsd = outTotalUsd * share;
    const ytOutUsd = outTotalUsd * (1 - share);

    const pendleMeta = {
      marketAddress: market.address,
      ptAddress,
      ytAddress: market.yt,
      syAddress: market.sy,
      underlyingAsset: market.underlyingAsset,
      expiry: market.expiry,
    };
    const legItem = (
      leg: "pt" | "yt",
      instrument: string,
      outWei: bigint,
      inUsd: number | null,
      outUsd: number,
    ): Record<string, unknown> => ({
      type: "swap",
      chain: chainSlug,
      status: "closed",
      inputToken: instrument,
      outputToken,
      inputTokenAddress: instrument,
      outputTokenAddress: outputToken,
      // SELL: inputAmount is the RAW PT/YT quantity burned (reduces the lot);
      // PT and YT burn EQUAL amounts.
      inputAmount: amountWei.toString(),
      outputAmount: outWei.toString(),
      inputValueUsd: String(inUsd ?? outUsd),
      outputValueUsd: String(outUsd),
      valuationSource: "pendle",
      signature: txHash,
      walletAddress: wallet,
      tradeSide: "sell",
      instrumentKey: `${chainSlug}:${instrument.toLowerCase()}`,
      settlementAssetKey: outputToken,
      meta: { protocol: "pendle", side: "redeem-py", leg, pendle: pendleMeta },
    });

    logger.info("pendle.py.redeem.executed", { market: market.address, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({ txHash, action: "redeem", pt: ptAddress, yt: ytAddress, outputToken, amountIn: amountInRaw, amountOut: humanAmount(outAmount, outDec).toString() }, null, 2),
      data: {
        txHash,
        _tradeCapture: {
          type: "swap",
          chain: chainSlug,
          status: "closed",
          walletAddress: wallet,
          tradeSide: "sell",
          instrumentKey: `${chainSlug}:${ptAddress.toLowerCase()}`,
          inputTokenAddress: ptAddress,
          outputTokenAddress: outputToken,
          inputAmount: amountWei.toString(),
          outputAmount: outAmount,
          inputValueUsd: String(outTotalUsd),
          outputValueUsd: String(outTotalUsd),
          valuationSource: "pendle",
          signature: txHash,
          settlementAssetKey: outputToken,
          meta: { protocol: "pendle", side: "redeem-py", pendle: pendleMeta },
        },
        _tradeCaptureItems: [
          legItem("pt", ptAddress, ptOutWei, ptInUsd, ptOutUsd),
          legItem("yt", ytAddress, ytOutWei, ytInUsd, ytOutUsd),
        ],
      },
    };
  } catch (err) {
    return fail(`Pendle redeem failed (${failureDetail("pendle.py.redeem", err)})`);
  }
}

export const PENDLE_PY_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.py.quote": (p, ctx) => pendlePyQuote(p, ctx),
  "pendle.py.mint": (p, ctx) => executePendleMint(p, ctx),
  "pendle.py.redeem": (p, ctx) => executePendleRedeemPy(p, ctx),
};
