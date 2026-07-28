/**
 * Pendle LP handlers — quote (read) + single-token add / remove (mutating).
 *
 * `pendle.lp.add` deposits ONE payment token into a Pendle market and receives the
 * market's LP token (Convert action `add-liquidity`, `addLiquiditySingleToken`).
 * `pendle.lp.remove` burns the LP token back to ONE output token (Convert action
 * `remove-liquidity`, `removeLiquiditySingleToken`). The MARKET address IS the LP
 * token; it is the anchor bound end-to-end (instrument guard → identity → calldata).
 *
 * Both mutating paths mirror the PT/YT/PY discipline: fresh Convert re-fetch →
 * `selectSafeRoute` fund-safety extractor (Router pin, receiver == wallet, market ==
 * quoted, exact spend, EXACT approval set — add approves the input token, remove
 * approves the LP/market token) → exact allowance to the pinned Router → broadcast.
 * They are approval-gated + prequote-gated (add → kind `lp_add`; remove → kind
 * `lp_remove`).
 *
 * Capture writes a plain `proj_activity` row (`type:"lp"`, with a per-chain
 * `positionKey` for provenance and a protocol-neutral `meta.lpLegs` block for the
 * recorded amounts) — NOT a position projection. Agent Scan Phase 1 retired
 * LP-lifecycle tracking and LP economics (`sync/projectors/lp.ts` and
 * `db/repos/lp-events.ts` deleted): `position-projector.ts`'s `lp` case is now a
 * no-op, so neither add nor remove opens/closes a tracked position or writes
 * LP-economics rows — the agent reads recorded amounts back via `agent_scan`'s
 * `transactions`/`activity` views instead. Upstream error text NEVER reaches the model.
 */

import { getAddress, parseUnits, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER, PENDLE_ERC20_ABI } from "@tools/pendle/constants.js";
import { getPendleEvmClients, getPendlePublicClient } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import type { PendleMarket } from "@tools/pendle/types.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

import { resolveMarketByAddress, buildAssetMap, priceUsdFor } from "../market-lookup.js";
import { resolveExitMarketByAddress } from "../matured-market-lookup.js";
import { explainUnresolvedPendleMarket } from "../matured-refusal.js";
import { selectSafeRoute, type PendleTxIntent } from "../calldata.js";
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

/** The bounded Pendle market context stamped onto every LP capture's meta. */
function pendleMetaBlock(market: PendleMarket): Record<string, unknown> {
  return {
    marketAddress: market.address,
    ptAddress: market.pt,
    ytAddress: market.yt,
    syAddress: market.sy,
    underlyingAsset: market.underlyingAsset,
    expiry: market.expiry,
  };
}

/** Stable per-chain LP position key — identical for the add (open) and remove (close). */
function lpPositionKey(slug: string, marketAddress: string, wallet: string): string {
  return `${slug}:lp:${marketAddress.toLowerCase()}:${wallet.toLowerCase()}`;
}

/** LP token instrument key (market == LP token). */
function lpInstrumentKey(slug: string, marketAddress: string): string {
  return `${slug}:lp:${marketAddress.toLowerCase()}`;
}

// ── Quote ────────────────────────────────────────────────────────────

async function pendleLpQuote(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), direction = str(p, "direction"), marketRaw = str(p, "market"), amountInRaw = str(p, "amountIn");
  if (!chain || !marketRaw || !amountInRaw) return fail("Missing required: chain, market, amountIn");
  if (direction !== "add" && direction !== "remove") {
    return fail("direction must be 'add' (token → LP) or 'remove' (LP → token).");
  }
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const receiver = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
    const marketAddress = requireTokenAddress(marketRaw);

    // INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): the `market` must
    // resolve on the resolved chain. A quote with no market anchor must never
    // record an LP identity that could authorize an execute on the wrong
    // instrument.
    //
    // R5b matrix: a REMOVE quote resolves matured markets (removal is legal
    // after expiry and must quote for the position the user actually holds); an
    // ADD quote stays ACTIVE-ONLY and names maturity as the refusal reason.
    const market = direction === "remove"
      ? (await resolveExitMarketByAddress(chainId, marketAddress))?.market ?? null
      : await resolveMarketByAddress(chainId, marketAddress);
    if (!market || !market.address) {
      if (direction === "add") {
        return fail(await explainUnresolvedPendleMarket(chainId, chainEntry.slug, marketAddress, { action: "lp.add", leg: "market" }));
      }
      return fail("`market` is not a Pendle market on this chain — find it via pendle.yields.");
    }
    const marketAddr = getAddress(market.address);
    const slippage = resolvePendleSlippage("pendle.lp.quote", num(p, "slippageBps"));
    const client = getPendleClient();
    const assetMap = await buildAssetMap(chainId);
    const slippageBpsEcho = num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;

    if (direction === "add") {
      const tokenIn = await resolveInputToken(chainEntry, str(p, "tokenIn"));
      const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
      const response = await client.convertMulti(chainId, {
        receiver,
        inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
        outputs: [marketAddr],
        slippage: slippage.fraction,
      });
      if (!response || response.routes.length === 0) return fail("Pendle returned no add-liquidity route for these tokens.");
      if (response.action !== "add-liquidity") {
        return fail("Pendle did not return an add-liquidity route — for a plain PT buy use pendle.pt.buy.");
      }
      const best = response.routes[0]!;
      const lpOut = best.outputs.find((o) => o.token.toLowerCase() === marketAddr.toLowerCase())?.amount ?? "0";
      const lpDec = assetMap.get(marketAddr.toLowerCase())?.decimals ?? 18;
      // Echo EXACTLY the fields `extractPendleLpQuote` validates. `chainId` is the
      // RESOLVED chain; tokenIn = payment token, tokenOut = the LP (market) anchor.
      return ok({
        action: "add-liquidity",
        direction: "add",
        chainId,
        tokenIn: { address: tokenIn.address, isNative: tokenIn.isNative },
        tokenOut: { address: marketAddr },
        market: marketAddr,
        receiver,
        expiry: market.expiry ?? null,
        liquidityUsd: market.details.liquidity ?? null,
        priceImpact: best.data.priceImpact,
        feeUsdEstimate: best.data.feeUsd,
        amountIn: amountInRaw,
        amountOut: humanAmount(lpOut, lpDec).toString(),
        aggregator: best.data.aggregatorType,
        slippageBps: slippageBpsEcho,
      });
    }

    // direction === "remove" (LP → token). The LP token IS the market; read its
    // decimals on-chain like any ERC-20.
    const lpToken = await resolveInputToken(chainEntry, marketRaw);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return fail("No output token — pass tokenOut (the market has no underlying to default to).");
    const amountWei = parseUnits(amountInRaw, lpToken.decimals);
    const response = await client.convertMulti(chainId, {
      receiver,
      inputs: [{ token: marketAddr, amount: amountWei.toString() }],
      outputs: [outputToken],
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) return fail("Pendle returned no remove-liquidity route.");
    if (response.action !== "remove-liquidity") {
      return fail("Pendle did not return a remove-liquidity route for this market.");
    }
    const best = response.routes[0]!;
    const outAmount = best.outputs[0]?.amount ?? "0";
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    return ok({
      action: "remove-liquidity",
      direction: "remove",
      chainId,
      tokenIn: { address: marketAddr },
      tokenOut: { address: outputToken },
      market: marketAddr,
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
    return fail(`Pendle LP quote unavailable (${failureDetail("pendle.lp.quote", err)})`);
  }
}

// ── Add (token → LP) ─────────────────────────────────────────────────

async function executePendleLpAdd(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), marketRaw = str(p, "market"), tokenInRaw = str(p, "tokenIn"), amountInRaw = str(p, "amountIn");
  if (!chain || !marketRaw || !tokenInRaw || !amountInRaw) {
    return fail("Missing required: chain, market, tokenIn, amountIn");
  }
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the deposit is already on-chain.
  let txHash: Hex | undefined;
  const toolId = "pendle.lp.add";
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
          toolId, eventRole: "yield_lp", chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p, tokenOut: { tokenAddress: marketAddress },
        },
        failureCode,
        message,
      );
      return fail(message);
    };
    // ACTIVE-ONLY (R5b matrix): adding liquidity after expiry is impossible, so
    // the financial resolver never sees a matured market here; the reason is
    // named from the read-only classification lane instead.
    const market = await resolveMarketByAddress(chainId, marketAddress);
    if (!market || !market.address) {
      return refuse("route_not_found", await explainUnresolvedPendleMarket(chainId, chainSlug, marketAddress, { action: "lp.add", leg: "market" }));
    }
    const marketAddr = getAddress(market.address);
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = resolvePendleSlippage("pendle.lp.add", num(p, "slippageBps"));

    if (p.dryRun === true) {
      const response = await getPendleClient().convertMulti(chainId, {
        receiver: PENDLE_ROUTER, // placeholder — dry-run never signs
        inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
        outputs: [marketAddr],
        slippage: slippage.fraction,
      });
      const best = response?.routes[0];
      return ok({ dryRun: true, action: "add", market: marketAddr, tokenIn: tokenIn.address, aggregator: best?.data.aggregatorType ?? null, priceImpact: best?.data.priceImpact ?? null, feeUsdEstimate: best?.data.feeUsd ?? null });
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
      outputs: [marketAddr],
      slippage: slippage.fraction,
    });
    if (!response) return refuse("route_not_found", "Pendle returned no add-liquidity route for these tokens.");
    if (response.action !== "add-liquidity") {
      return refuse("route_not_found", "Pendle did not return an add-liquidity route for this market.");
    }

    const intent: PendleTxIntent = {
      action: "lp-add",
      wallet,
      // The tolerance this route is held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      inputToken: tokenIn.address,
      inputAmountWei: amountWei,
      isNative: tokenIn.isNative,
      // addLiquiditySingleToken carries the MARKET at arg 1 — bind it to the quote.
      expectedMarket: marketAddr,
    };
    const route = selectSafeRoute(intent, response);

    // Approve EXACTLY the input token (native rejected upstream). Spender = Router.
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
    const quotedLpOut = route.outputs.find((o) => o.token.toLowerCase() === marketAddr.toLowerCase())?.amount ?? "0";
    const lpDec = assetMap.get(marketAddr.toLowerCase())?.decimals ?? 18;
    const quotedInUsd = legUsd(assetMap, tokenIn.address, humanAmount(amountWei, tokenIn.decimals));

    // SINGLE-TOKEN add is the shipped shape — one in, one out. The Option-C
    // second-leg columns stay NULL, and migration 053's `yield_lp` predicate
    // applies its dual invariants only where they are populated.
    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: tokenIn.isNative ? amountWei : 0n },
      {
        toolId, eventRole: "yield_lp", chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(tokenIn.address, assetMap.get(tokenIn.address.toLowerCase())?.symbol, tokenIn.decimals, amountWei.toString(), humanAmount(amountWei, tokenIn.decimals).toString()),
        tokenOut: legInput(marketAddr, assetMap.get(marketAddr.toLowerCase())?.symbol, lpDec, quotedLpOut, humanAmount(quotedLpOut, lpDec).toString()),
        ...(quotedInUsd !== null ? { usdInEst: String(quotedInUsd) } : {}),
        routeProvenance: { action: "lp-add", aggregator: route.data.aggregatorType, market: marketAddr },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    const lpOut = broadcast.executed.amountOutRaw ?? quotedLpOut;
    const depositedWei = BigInt(broadcast.executed.amountInRaw ?? amountWei.toString());
    const inUsd = legUsd(assetMap, tokenIn.address, humanAmount(depositedWei, tokenIn.decimals));

    logger.info("pendle.lp.add.executed", { market: marketAddr, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash, action: "add", market: marketAddr, tokenIn: tokenIn.address,
        amountIn: amountInRaw,
        executedLpOut: humanAmount(lpOut, lpDec).toString(),
        quotedLpOut: humanAmount(quotedLpOut, lpDec).toString(),
      }, null, 2),
      data: {
        txHash,
        _executionId: broadcast.executionId,
        _tradeCapture: {
          type: "lp",
          chain: chainSlug,
          status: "executed",
          walletAddress: wallet,
          positionKey: lpPositionKey(chainSlug, marketAddr, wallet),
          instrumentKey: lpInstrumentKey(chainSlug, marketAddr),
          // Honest Pendle-priced USD when available; honest null/none otherwise.
          inputValueUsd: inUsd !== null ? String(inUsd) : undefined,
          valuationSource: inUsd !== null ? "pendle" : "none",
          meta: {
            dex: "pendle",
            pool: marketAddr,
            action: "lp-add",
            pendle: pendleMetaBlock(market),
            // Protocol-neutral cashflow legs → proj_lp_event_legs (deposit side).
            lpLegs: [
              {
                legType: "deposit",
                tokenAddress: tokenIn.address,
                // The DECODED deposit — a cashflow leg is evidence, not intent.
                amountRaw: depositedWei.toString(),
                amountUsd: inUsd !== null ? String(inUsd) : undefined,
              },
            ],
          },
        },
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.lp.add", txHash, err);
    return fail(`Pendle add liquidity failed (${failureDetail("pendle.lp.add", err)})`);
  }
}

// ── Remove (LP → token) ──────────────────────────────────────────────

async function executePendleLpRemove(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), marketRaw = str(p, "market"), amountInRaw = str(p, "amountIn");
  if (!chain || !marketRaw || !amountInRaw) return fail("Missing required: chain, market, amountIn");
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the withdrawal is already on-chain.
  let txHash: Hex | undefined;
  const toolId = "pendle.lp.remove";
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
          toolId, eventRole: "yield_lp", chainId, chainSlug,
          walletAddress: resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
          sessionId, intentParams: p, tokenIn: { tokenAddress: marketAddress },
        },
        failureCode,
        message,
      );
      return fail(message);
    };
    // EXIT PATH (R5b): removal is legal after expiry — Pendle documents remove
    // as "callable regardless of the market's expiry" — so this resolves the
    // matured catalogue too. An inactive row is only believed on a parseable,
    // past expiry; anything else is refused by name inside the resolver.
    const resolved = await resolveExitMarketByAddress(chainId, marketAddress);
    if (!resolved || !resolved.market.address) {
      return refuse("route_not_found", "No Pendle market at this address — check pendle.yields (includeMatured:true covers expired markets).");
    }
    const market = resolved.market;
    const marketAddr = getAddress(market.address);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return refuse("route_not_found", "No output token — pass tokenOut (the market has no underlying to default to).");
    // LP token decimals read ON-CHAIN (the market IS a plain ERC-20 LP token).
    const lpToken = await resolveInputToken(chainEntry, marketRaw);
    const amountWei = parseUnits(amountInRaw, lpToken.decimals);
    const slippage = resolvePendleSlippage("pendle.lp.remove", num(p, "slippageBps"));

    if (p.dryRun === true) {
      return ok({ dryRun: true, action: "remove", market: marketAddr, tokenOut: outputToken });
    }

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
      inputs: [{ token: marketAddr, amount: amountWei.toString() }],
      outputs: [outputToken],
      slippage: slippage.fraction,
    });
    if (!response) return refuse("route_not_found", "Pendle returned no remove-liquidity route.");
    if (response.action !== "remove-liquidity") {
      return refuse("route_not_found", "Pendle did not return a remove-liquidity route for this market.");
    }

    const intent: PendleTxIntent = {
      action: "lp-remove",
      wallet,
      // The tolerance this route is held to — see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      // The "input" being spent is the LP (market) token — approvals bind to it.
      inputToken: marketAddr,
      inputAmountWei: amountWei,
      isNative: false,
      expectedMarket: marketAddr,
      expectedOutputToken: outputToken,
    };
    const route = selectSafeRoute(intent, response);

    // Approve EXACTLY the LP/market token (Convert asks for it), to the Router.
    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    for (const approval of response.requiredApprovals) {
      await ensurePendleAllowanceExact(publicClient, walletClient, getAddress(approval.token), PENDLE_ROUTER, BigInt(approval.amount));
    }

    // Full-exit detection (Codex): close the LP position ONLY when the removed LP
    // amount covers the wallet's ENTIRE LP balance. A partial remove reduces the
    // position but leaves it OPEN. Fail-safe: an unreadable balance → NOT a proven
    // full exit → leave open.
    let fullExit = false;
    try {
      const lpBalance = (await getPendlePublicClient(chainId).readContract({
        address: marketAddr,
        abi: PENDLE_ERC20_ABI,
        functionName: "balanceOf",
        args: [wallet],
      })) as bigint;
      fullExit = amountWei >= lpBalance;
    } catch {
      fullExit = false;
    }

    const assetMap = await buildAssetMap(chainId);
    const quotedOutRaw = route.outputs[0]?.amount ?? "0";
    const outDec = assetMap.get(outputToken.toLowerCase())?.decimals ?? null;
    const lpDec = assetMap.get(marketAddr.toLowerCase())?.decimals ?? lpToken.decimals;

    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: "yield_lp", chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(marketAddr, assetMap.get(marketAddr.toLowerCase())?.symbol, lpDec, amountWei.toString(), humanAmount(amountWei, lpDec).toString()),
        tokenOut: legInput(outputToken, assetMap.get(outputToken.toLowerCase())?.symbol, outDec, quotedOutRaw, humanAmount(quotedOutRaw, outDec).toString()),
        routeProvenance: { action: "lp-remove", aggregator: route.data.aggregatorType, market: marketAddr, fullExit },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    const outAmount = broadcast.executed.amountOutRaw ?? quotedOutRaw;
    const outUsd = legUsd(assetMap, outputToken, humanAmount(outAmount, outDec));

    logger.info("pendle.lp.remove.executed", { market: marketAddr, fullExit, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash, action: "remove", market: marketAddr, tokenOut: outputToken,
        amountIn: amountInRaw,
        executedAmountOut: humanAmount(outAmount, outDec).toString(),
        quotedAmountOut: humanAmount(quotedOutRaw, outDec).toString(),
        fullExit,
      }, null, 2),
      data: {
        txHash,
        _executionId: broadcast.executionId,
        _tradeCapture: {
          type: "lp",
          chain: chainSlug,
          // A proven full exit closes the position; a partial remove keeps it open.
          status: fullExit ? "closed" : "executed",
          walletAddress: wallet,
          positionKey: lpPositionKey(chainSlug, marketAddr, wallet),
          instrumentKey: lpInstrumentKey(chainSlug, marketAddr),
          outputValueUsd: outUsd !== null ? String(outUsd) : undefined,
          valuationSource: outUsd !== null ? "pendle" : "none",
          meta: {
            dex: "pendle",
            pool: marketAddr,
            action: "lp-remove",
            // Whether this remove fully exits the position (drives the close).
            fullExit,
            pendle: pendleMetaBlock(market),
            // Protocol-neutral cashflow legs → proj_lp_event_legs (withdraw side).
            lpLegs: [
              {
                legType: "withdraw",
                tokenAddress: outputToken,
                // The DECODED withdrawal — a cashflow leg is evidence, not intent.
                amountRaw: outAmount,
                amountUsd: outUsd !== null ? String(outUsd) : undefined,
              },
            ],
          },
        },
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.lp.remove", txHash, err);
    return fail(`Pendle remove liquidity failed (${failureDetail("pendle.lp.remove", err)})`);
  }
}

export const PENDLE_LP_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.lp.quote": (p, ctx) => pendleLpQuote(p, ctx),
  "pendle.lp.add": (p, ctx) => executePendleLpAdd(p, ctx),
  "pendle.lp.remove": (p, ctx) => executePendleLpRemove(p, ctx),
};
