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

    // INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): the `market` must be
    // an active Pendle market on the resolved chain. A quote with no market anchor
    // must never record an LP identity that could authorize an execute on the wrong
    // instrument.
    const market = await resolveMarketByAddress(chainId, marketAddress);
    if (!market || !market.address) {
      return fail("`market` is not an active Pendle market on this chain — find it via pendle.yields.");
    }
    const marketAddr = getAddress(market.address);
    const slippage = slippageFraction(num(p, "slippageBps"));
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
        slippage,
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
      slippage,
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
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const marketAddress = requireTokenAddress(marketRaw);
    const market = await resolveMarketByAddress(chainId, marketAddress);
    if (!market || !market.address) {
      return fail("No active Pendle market at this address — check pendle.yields.");
    }
    const marketAddr = getAddress(market.address);
    const tokenIn = await resolveInputToken(chainEntry, tokenInRaw);
    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = slippageFraction(num(p, "slippageBps"));

    if (p.dryRun === true) {
      const response = await getPendleClient().convertMulti(chainId, {
        receiver: PENDLE_ROUTER, // placeholder — dry-run never signs
        inputs: [{ token: tokenIn.address, amount: amountWei.toString() }],
        outputs: [marketAddr],
        slippage,
      });
      const best = response?.routes[0];
      return ok({ dryRun: true, action: "add", market: marketAddr, tokenIn: tokenIn.address, aggregator: best?.data.aggregatorType ?? null, priceImpact: best?.data.priceImpact ?? null });
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
      slippage,
    });
    if (!response) return fail("Pendle returned no add-liquidity route for these tokens.");
    if (response.action !== "add-liquidity") {
      return fail("Pendle did not return an add-liquidity route for this market.");
    }

    const intent: PendleTxIntent = {
      action: "lp-add",
      wallet,
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
    const txHash = await walletClient.sendTransaction({
      account: walletClient.account,
      chain: walletClient.chain,
      to: getAddress(route.tx.to),
      data: route.tx.data as Hex,
      value: tokenIn.isNative ? amountWei : 0n,
    });

    const assetMap = await buildAssetMap(chainId);
    const lpOut = route.outputs.find((o) => o.token.toLowerCase() === marketAddr.toLowerCase())?.amount ?? "0";
    const lpDec = assetMap.get(marketAddr.toLowerCase())?.decimals ?? 18;
    const inUsd = legUsd(assetMap, tokenIn.address, humanAmount(amountWei, tokenIn.decimals));

    logger.info("pendle.lp.add.executed", { market: marketAddr, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({ txHash, action: "add", market: marketAddr, tokenIn: tokenIn.address, amountIn: amountInRaw, lpOut: humanAmount(lpOut, lpDec).toString() }, null, 2),
      data: {
        txHash,
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
                amountRaw: amountWei.toString(),
                amountUsd: inUsd !== null ? String(inUsd) : undefined,
              },
            ],
          },
        },
      },
    };
  } catch (err) {
    return fail(`Pendle add liquidity failed (${failureDetail("pendle.lp.add", err)})`);
  }
}

// ── Remove (LP → token) ──────────────────────────────────────────────

async function executePendleLpRemove(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), marketRaw = str(p, "market"), amountInRaw = str(p, "amountIn");
  if (!chain || !marketRaw || !amountInRaw) return fail("Missing required: chain, market, amountIn");
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const marketAddress = requireTokenAddress(marketRaw);
    const market = await resolveMarketByAddress(chainId, marketAddress);
    if (!market || !market.address) {
      return fail("No active Pendle market at this address — check pendle.yields.");
    }
    const marketAddr = getAddress(market.address);
    const outRaw = str(p, "tokenOut");
    const outputToken = outRaw
      ? requireTokenAddress(outRaw)
      : market.underlyingAsset
        ? getAddress(market.underlyingAsset)
        : null;
    if (!outputToken) return fail("No output token — pass tokenOut (the market has no underlying to default to).");
    // LP token decimals read ON-CHAIN (the market IS a plain ERC-20 LP token).
    const lpToken = await resolveInputToken(chainEntry, marketRaw);
    const amountWei = parseUnits(amountInRaw, lpToken.decimals);
    const slippage = slippageFraction(num(p, "slippageBps"));

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
      slippage,
    });
    if (!response) return fail("Pendle returned no remove-liquidity route.");
    if (response.action !== "remove-liquidity") {
      return fail("Pendle did not return a remove-liquidity route for this market.");
    }

    const intent: PendleTxIntent = {
      action: "lp-remove",
      wallet,
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
    const outUsd = legUsd(assetMap, outputToken, humanAmount(outAmount, outDec));

    logger.info("pendle.lp.remove.executed", { market: marketAddr, fullExit, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({ txHash, action: "remove", market: marketAddr, tokenOut: outputToken, amountIn: amountInRaw, amountOut: humanAmount(outAmount, outDec).toString(), fullExit }, null, 2),
      data: {
        txHash,
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
                amountRaw: outAmount,
                amountUsd: outUsd !== null ? String(outUsd) : undefined,
              },
            ],
          },
        },
      },
    };
  } catch (err) {
    return fail(`Pendle remove liquidity failed (${failureDetail("pendle.lp.remove", err)})`);
  }
}

export const PENDLE_LP_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.lp.quote": (p, ctx) => pendleLpQuote(p, ctx),
  "pendle.lp.add": (p, ctx) => executePendleLpAdd(p, ctx),
  "pendle.lp.remove": (p, ctx) => executePendleLpRemove(p, ctx),
};
