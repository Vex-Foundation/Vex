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
import { explainUnresolvedPendleMarket } from "../matured-refusal.js";
import { selectSafeRoute, type PendleTxIntent } from "../calldata.js";
import { ptUsdShare, splitWei } from "../py-leg-split.js";
import { broadcastUnconfirmedFailure } from "./broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "./signed-broadcast.js";
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

// ── Route output lookup ──────────────────────────────────────────────

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
    // ACTIVE-ONLY (R5b matrix): both PY legs are pre-expiry actions.
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.address) {
      return fail(await explainUnresolvedPendleMarket(chainId, chainEntry.slug, ptAddress, { action: direction === "mint" ? "py.mint" : "py.redeem", leg: "PT" }));
    }
    const ytAddress = getAddress(market.yt);
    const slippage = resolvePendleSlippage("pendle.py.quote", num(p, "slippageBps"));
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
        slippage: slippage.fraction,
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
        feeUsdEstimate: best.data.feeUsd,
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
      slippage: slippage.fraction,
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
      feeUsdEstimate: best.data.feeUsd,
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
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the mint is already on-chain.
  let txHash: Hex | undefined;
  const toolId = "pendle.py.mint";
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);
    const ptAddress = requireTokenAddress(ptRaw);
    /** A pre-signature refusal, recorded as a hashless `definitively_failed` row. */
    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: "yield_py", chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p, tokenOut: { tokenAddress: ptAddress },
        },
        failureCode,
        message,
      );
      return fail(message);
    };
    // ACTIVE-ONLY (R5b matrix): minting PT+YT after expiry is impossible.
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.address) {
      return refuse("route_not_found", await explainUnresolvedPendleMarket(chainId, chainSlug, ptAddress, { action: "py.mint", leg: "PT" }));
    }
    const ytAddress = getAddress(market.yt);
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = resolvePendleSlippage("pendle.py.mint", num(p, "slippageBps"));

    if (p.dryRun === true) {
      const response = await getPendleClient().convertMulti(chainId, {
        receiver: PENDLE_ROUTER, // placeholder — dry-run never signs
        inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
        outputs: [ptAddress, ytAddress],
        slippage: slippage.fraction,
      });
      const best = response?.routes[0];
      return ok({ dryRun: true, action: "mint", pt: ptAddress, yt: ytAddress, market: market.address, aggregator: best?.data.aggregatorType ?? null, priceImpact: best?.data.priceImpact ?? null, feeUsdEstimate: best?.data.feeUsd ?? null });
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
      slippage: slippage.fraction,
    });
    if (!response) return refuse("route_not_found", "Pendle returned no mint route for these tokens.");
    if (response.action !== "mint-py") {
      return refuse("route_not_found", "Pendle did not return a mint route — for a plain PT buy use pendle.pt.buy.");
    }

    const intent: PendleTxIntent = {
      action: "py-mint",
      wallet,
      // The tolerance this route is held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
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
    // Read BEFORE signing — the staged row's legs need their decimals.
    const assetMap = await buildAssetMap(chainId);
    const quotedPtOut = outputAmountFor(route.outputs, ptAddress);
    const quotedYtOut = outputAmountFor(route.outputs, ytAddress);
    const ptDec = assetMap.get(ptAddress.toLowerCase())?.decimals ?? null;
    const ytDec = assetMap.get(ytAddress.toLowerCase())?.decimals ?? null;

    // OPTION C (migration 053): a mint is 1 → 2, so BOTH out legs are staged on
    // the one row. `yield_py` populates exactly ONE side — the OUT side here —
    // and confirming it requires proving both of them.
    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: tokenIn.isNative ? amountWei : 0n },
      {
        toolId, eventRole: "yield_py", chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(tokenIn.address, assetMap.get(tokenIn.address.toLowerCase())?.symbol, tokenIn.decimals, amountWei.toString(), humanAmount(amountWei, tokenIn.decimals).toString()),
        tokenOut: legInput(ptAddress, assetMap.get(ptAddress.toLowerCase())?.symbol, ptDec, quotedPtOut, humanAmount(quotedPtOut, ptDec).toString()),
        tokenOut2: legInput(ytAddress, assetMap.get(ytAddress.toLowerCase())?.symbol, ytDec, quotedYtOut, humanAmount(quotedYtOut, ytDec).toString()),
        routeProvenance: { action: "mint-py", aggregator: route.data.aggregatorType, market: market.address },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    // The DECODED mint — both minted legs proven from the receipt's own logs.
    const ptOut = broadcast.executed.amountOutRaw ?? quotedPtOut;
    const ytOut = broadcast.executed.amountOut2Raw ?? quotedYtOut;
    const spentWei = BigInt(broadcast.executed.amountInRaw ?? amountWei.toString());
    const ptPrice = priceUsdFor(assetMap, ptAddress);
    const ytPrice = priceUsdFor(assetMap, ytAddress);
    const ptOutUsd = ptPrice !== null ? humanAmount(ptOut, ptDec) * ptPrice : null;
    const ytOutUsd = ytPrice !== null ? humanAmount(ytOut, ytDec) * ytPrice : null;
    const share = ptUsdShare(ptOutUsd, ytOutUsd);
    // Split the amount ACTUALLY spent, not the amount requested.
    const [ptInWei, ytInWei] = splitWei(spentWei, share);
    // Total paid value from the payment leg (which almost always has a price);
    // fall back to the summed leg USD when the payment token is unpriced.
    const inTotalUsd = legUsd(assetMap, tokenIn.address, humanAmount(spentWei, tokenIn.decimals)) ?? ((ptOutUsd ?? 0) + (ytOutUsd ?? 0));
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
      output: JSON.stringify({
        txHash, action: "mint", pt: ptAddress, yt: ytAddress, market: market.address,
        amountIn: amountInRaw,
        executedPtOut: humanAmount(ptOut, ptDec).toString(),
        executedYtOut: humanAmount(ytOut, ytDec).toString(),
        quotedPtOut: humanAmount(quotedPtOut, ptDec).toString(),
        quotedYtOut: humanAmount(quotedYtOut, ytDec).toString(),
      }, null, 2),
      data: {
        txHash,
        _executionId: broadcast.executionId,
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
          inputAmount: spentWei.toString(),
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
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.py.mint", txHash, err);
    return fail(`Pendle mint failed (${failureDetail("pendle.py.mint", err)})`);
  }
}

// ── Redeem (pre-expiry PT+YT → token) ────────────────────────────────

async function executePendleRedeemPy(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), ptRaw = str(p, "pt"), amountInRaw = str(p, "amountIn");
  if (!chain || !ptRaw || !amountInRaw) return fail("Missing required: chain, pt, amountIn");
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the redeem is already on-chain.
  let txHash: Hex | undefined;
  const toolId = "pendle.py.redeem";
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);
    const ptAddress = requireTokenAddress(ptRaw);
    /** A pre-signature refusal, recorded as a hashless `definitively_failed` row. */
    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: "yield_py", chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p, tokenIn: { tokenAddress: ptAddress },
        },
        failureCode,
        message,
      );
      return fail(message);
    };
    // ACTIVE-ONLY (R5b matrix, Codex round-3 correction): the PT+YT pair
    // redemption is a PRE-EXPIRY action; after maturity the PT redeems alone
    // via pendle.pt.redeem, so the financial resolver never sees a matured
    // market here — the refusal is named from the read-only lane.
    const market = await resolveMarketByPt(chainId, ptAddress);
    if (!market || !market.yt || !market.address) {
      return refuse("route_not_found", await explainUnresolvedPendleMarket(chainId, chainSlug, ptAddress, { action: "py.redeem", leg: "PT" }));
    }
    const ytAddress = getAddress(market.yt);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return refuse("route_not_found", "No output token — pass tokenOut (the market has no underlying to default to).");
    // PT decimals read ON-CHAIN (a PT is a plain ERC-20). PT and YT are minted 1:1
    // and share decimals, so the equal-leg burn amount uses the same wei.
    const ptToken = await resolveInputToken(chainEntry, ptRaw);
    const amountWei = parseUnits(amountInRaw, ptToken.decimals);
    const slippage = resolvePendleSlippage("pendle.py.redeem", num(p, "slippageBps"));

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
      slippage: slippage.fraction,
    });
    if (!response) return refuse("route_not_found", "Pendle returned no pre-expiry redeem route.");
    if (response.action !== "redeem-py") {
      return refuse("route_not_found", "Pendle did not return a pre-expiry redeem route — a MATURED PT uses pendle.pt.redeem.");
    }

    const intent: PendleTxIntent = {
      action: "py-redeem",
      wallet,
      // The tolerance this route is held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
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
    const assetMap = await buildAssetMap(chainId);
    const quotedOutRaw = route.outputs[0]?.amount ?? "0";
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    const ptDec = assetMap.get(ptAddress.toLowerCase())?.decimals ?? ptToken.decimals;
    const ytDec = assetMap.get(ytAddress.toLowerCase())?.decimals ?? ptToken.decimals;

    // OPTION C (migration 053): a pre-expiry redeem is 2 → 1, so BOTH burned
    // legs are staged on the one row — the mirror image of the mint above.
    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: "yield_py", chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(ptAddress, assetMap.get(ptAddress.toLowerCase())?.symbol, ptDec, amountWei.toString(), humanAmount(amountWei, ptDec).toString()),
        tokenIn2: legInput(ytAddress, assetMap.get(ytAddress.toLowerCase())?.symbol, ytDec, amountWei.toString(), humanAmount(amountWei, ytDec).toString()),
        tokenOut: legInput(outputToken, assetMap.get(outputToken.toLowerCase())?.symbol, outDec, quotedOutRaw, humanAmount(quotedOutRaw, outDec).toString()),
        routeProvenance: { action: "redeem-py", aggregator: route.data.aggregatorType, market: market.address },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    // The DECODED redeem — both burns and the credit proven from the receipt.
    const outAmount = broadcast.executed.amountOutRaw ?? quotedOutRaw;
    const ptBurnedWei = BigInt(broadcast.executed.amountInRaw ?? amountWei.toString());
    const ytBurnedWei = BigInt(broadcast.executed.amountIn2Raw ?? amountWei.toString());
    const ptPrice = priceUsdFor(assetMap, ptAddress);
    const ytPrice = priceUsdFor(assetMap, ytAddress);
    const ptInUsd = ptPrice !== null ? humanAmount(ptBurnedWei, ptDec) * ptPrice : null;
    const ytInUsd = ytPrice !== null ? humanAmount(ytBurnedWei, ytDec) * ytPrice : null;
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
      burnedWei: bigint,
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
      // SELL: inputAmount is the RAW PT/YT quantity ACTUALLY burned (reduces the
      // lot). Decoded per leg rather than assumed equal: the pair is minted 1:1,
      // but a lot must record what the receipt proved, not what the shape implies.
      inputAmount: burnedWei.toString(),
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
      output: JSON.stringify({
        txHash, action: "redeem", pt: ptAddress, yt: ytAddress, outputToken,
        amountIn: amountInRaw,
        executedAmountOut: humanAmount(outAmount, outDec).toString(),
        quotedAmountOut: humanAmount(quotedOutRaw, outDec).toString(),
      }, null, 2),
      data: {
        txHash,
        _executionId: broadcast.executionId,
        _tradeCapture: {
          type: "swap",
          chain: chainSlug,
          status: "closed",
          walletAddress: wallet,
          tradeSide: "sell",
          instrumentKey: `${chainSlug}:${ptAddress.toLowerCase()}`,
          inputTokenAddress: ptAddress,
          outputTokenAddress: outputToken,
          inputAmount: ptBurnedWei.toString(),
          outputAmount: outAmount,
          inputValueUsd: String(outTotalUsd),
          outputValueUsd: String(outTotalUsd),
          valuationSource: "pendle",
          signature: txHash,
          settlementAssetKey: outputToken,
          meta: { protocol: "pendle", side: "redeem-py", pendle: pendleMeta },
        },
        _tradeCaptureItems: [
          legItem("pt", ptAddress, ptBurnedWei, ptOutWei, ptInUsd, ptOutUsd),
          legItem("yt", ytAddress, ytBurnedWei, ytOutWei, ytInUsd, ytOutUsd),
        ],
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.py.redeem", txHash, err);
    return fail(`Pendle redeem failed (${failureDetail("pendle.py.redeem", err)})`);
  }
}

export const PENDLE_PY_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.py.quote": (p, ctx) => pendlePyQuote(p, ctx),
  "pendle.py.mint": (p, ctx) => executePendleMint(p, ctx),
  "pendle.py.redeem": (p, ctx) => executePendleRedeemPy(p, ctx),
};
