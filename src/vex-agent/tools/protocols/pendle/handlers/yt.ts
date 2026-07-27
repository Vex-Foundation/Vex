/**
 * Pendle YT handlers — quote (read) + buy / sell (mutating) + claim (mutating).
 *
 * YT (yield token) is the VARIABLE / leveraged-yield leg of a Pendle market: it
 * accrues the underlying yield until expiry and then DECAYS TO ZERO. It is NOT
 * fixed yield. Buy/sell mirror the PT swap path exactly (fresh Convert re-fetch →
 * `selectSafeRoute` fund-safety extractor → exact allowance to the pinned Router →
 * broadcast → spot capture) but bind the YT-specific Router methods
 * (`swapExactTokenForYt` / `swapExactYtForToken`).
 *
 * Claim is an INCOME SWEEP (`redeemDueInterestAndRewardsV2`): it collects accrued
 * YT interest + rewards and LP rewards for the wallet's positions on ONE chain in
 * a single tx. Which markets it sweeps — and which eligible ones the
 * per-transaction cap leaves out, always reported, never silent — is owned by
 * `../claim-targets.ts`. There is nothing to quote (no prequote), but it is approval-gated,
 * Router-pinned, and FULL-decoded via `assertClaimSafe` before signing — funds
 * land on the wallet by protocol (no receiver arg exists), the only external-call
 * surface (`swaps`) is bound empty, and the ONLY allowance a claim may grant is
 * the market's own SY, exact-amount, to the pinned Router (source-verified: the
 * Router pulls the freshly-redeemed SY interest — ActionMiscV3.sol:117-126).
 * Upstream error text NEVER reaches the model.
 */

import { getAddress, parseUnits, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

import { resolveMarketByYt, buildAssetMap } from "../market-lookup.js";
import { buildPendleClaimTargets, describePendleClaimSkips } from "../claim-targets.js";
import {
  selectSafeRoute,
  assertClaimSafe,
  type PendleAction,
  type PendleTxIntent,
  type PendleClaimIntent,
} from "../calldata.js";
import { broadcastUnconfirmedFailure } from "./broadcast-unconfirmed.js";
import {
  failureDetail,
  humanAmount,
  legUsd,
  requirePendleChain,
  requireTokenAddress,
  resolveInputToken,
  slippageFraction,
} from "./shared.js";

/**
 * The plain-language decay warning surfaced in the YT quote output so the model
 * always sees the horizon and never frames YT as fixed yield.
 */
const YT_DECAY_WARNING =
  "A YT decays toward zero as expiry approaches — it is variable, leveraged yield exposure, not a fixed return, and is worth nothing after expiry. This is not fixed yield; size and time it accordingly.";

// ── Quote ────────────────────────────────────────────────────────────

async function pendleYtQuote(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
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

    // INSTRUMENT GUARD (fail-closed, BEFORE any Convert call): EXACTLY one leg
    // must be an active YT on the resolved chain (out → buy, in → sell). Without
    // this, a quote with two non-YT legs would still record a GENERIC swap
    // identity that could authorize the PT execute for the same legs — skipping
    // the PT term-lock warning path. Instrument confusion is a fund-safety hole,
    // so the quote refuses instead of degrading.
    const marketByOut = await resolveMarketByYt(chainId, tokenOut);
    const marketByIn = await resolveMarketByYt(chainId, tokenIn.address);
    if (marketByOut && marketByIn) {
      return fail("Both tokens are Pendle YTs — trade a YT against a payment token, one leg at a time.");
    }
    if (!marketByOut && !marketByIn) {
      return fail("Neither token is an active Pendle YT on this chain — find the YT via pendle.yields, or use pendle.pt.quote for PT trades.");
    }
    const market = (marketByOut ?? marketByIn)!;
    const ytAddress = marketByOut ? tokenOut : tokenIn.address;
    const direction: "buy" | "sell" = marketByOut ? "buy" : "sell";

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
      return fail("Pendle returned no route for this YT trade.");
    }
    const best = response.routes[0]!;

    const assetMap = await buildAssetMap(chainId);
    const outAmount = best.outputs[0]?.amount ?? "0";
    const outDecimals = assetMap.get(tokenOut.toLowerCase())?.decimals ?? null;

    // Echo the fields `extractPendleQuote` validates, with `instrument: "yt"` so
    // the recorder does NOT emit a PT-style term-lock (a YT is not locked — it
    // decays). `chainId` is the RESOLVED chain (the swap prequote identity binds
    // it). market/yt are guaranteed non-null by the instrument guard above; a YT
    // trade is ALWAYS a swap (never redeem-py), so `action` is fixed "swap".
    return ok({
      action: "swap",
      instrument: "yt",
      direction,
      chainId,
      tokenIn: { address: tokenIn.address, isNative: tokenIn.isNative },
      tokenOut: { address: tokenOut },
      pt: market.pt ?? null,
      yt: ytAddress,
      market: market.address,
      receiver,
      expiry: market.expiry ?? null,
      liquidityUsd: market.details.liquidity ?? null,
      priceImpact: best.data.priceImpact,
      feeUsdEstimate: best.data.feeUsd,
      amountIn: amountInRaw,
      amountOut: humanAmount(outAmount, outDecimals).toString(),
      aggregator: best.data.aggregatorType,
      slippageBps: num(p, "slippageBps") ?? 50,
      decayWarning: YT_DECAY_WARNING,
    });
  } catch (err) {
    return fail(`Pendle YT quote unavailable (${failureDetail("pendle.yt.quote", err)})`);
  }
}

// ── Buy / Sell (token↔YT swap) ───────────────────────────────────────

async function executePendleYtSwap(
  p: Record<string, unknown>,
  side: "yt-buy" | "yt-sell",
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) {
    return fail("Missing required: chain, tokenIn, tokenOut, amountIn");
  }
  const tradeSide: "buy" | "sell" = side === "yt-buy" ? "buy" : "sell";
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

    // YT + canonical market — buy: YT is tokenOut; sell: YT is tokenIn.
    const ytAddress = side === "yt-buy" ? tokenOut : tokenIn.address;
    const market = await resolveMarketByYt(chainId, ytAddress);
    if (!market || !market.address) {
      return fail("No active Pendle market for this YT — check pendle.yields.");
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
      return ok({ dryRun: true, side: tradeSide, instrument: "yt", market: expectedMarket, expiry: market.expiry, aggregator: best?.data.aggregatorType ?? null, priceImpact: best?.data.priceImpact ?? null, feeUsdEstimate: best?.data.feeUsd ?? null, decayWarning: YT_DECAY_WARNING });
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
    if (!response) return fail("Pendle returned no route for this YT trade.");
    if (response.action !== "swap") {
      return fail("Pendle did not return a YT swap route — check the market is active and not matured.");
    }

    const intent: PendleTxIntent = {
      action: side as PendleAction,
      wallet,
      inputToken: tokenIn.address,
      inputAmountWei: amountWei,
      isNative: tokenIn.isNative,
      expectedMarket,
      // Sell: bind the decoded TokenOutput.tokenOut to the quoted payment token.
      ...(side === "yt-sell" ? { expectedOutputToken: tokenOut } : {}),
    };
    const route = selectSafeRoute(intent, response);

    // Approve EXACTLY the required input token (spender = the pinned Router).
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

    // Exact USD valuation from Pendle prices (the payment leg always has a price).
    const assetMap = await buildAssetMap(chainId);
    const outAmount = route.outputs[0]?.amount ?? "0";
    const outDecimals = assetMap.get(tokenOut.toLowerCase())?.decimals ?? null;
    const inHuman = humanAmount(amountWei, tokenIn.decimals);
    const outHuman = humanAmount(outAmount, outDecimals);
    const inUsd = legUsd(assetMap, tokenIn.address, inHuman);
    const outUsd = legUsd(assetMap, tokenOut, outHuman);
    const inputValueUsd = inUsd ?? outUsd ?? 0;
    const outputValueUsd = outUsd ?? inUsd ?? 0;

    logger.info("pendle.yt.swap.executed", { side: tradeSide, market: expectedMarket, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({ txHash, side: tradeSide, instrument: "yt", market: expectedMarket, tokenIn: tokenIn.address, tokenOut, amountIn: amountInRaw, amountOut: outHuman.toString() }, null, 2),
      data: {
        txHash,
        _tradeCapture: {
          type: "swap",
          chain: chainSlug, // resolves selective balance sync to the traded chain
          status: "executed",
          inputToken: tokenIn.address,
          outputToken: tokenOut,
          inputTokenAddress: tokenIn.address,
          outputTokenAddress: tokenOut,
          // RAW base-unit strings — the spot lot projector BigInt()s these.
          inputAmount: amountWei.toString(),
          outputAmount: outAmount,
          inputValueUsd: String(inputValueUsd),
          outputValueUsd: String(outputValueUsd),
          valuationSource: "pendle",
          signature: txHash,
          walletAddress: wallet,
          tradeSide,
          // The INSTRUMENT is the YT (distinct lot key from the market's PT).
          instrumentKey: `${chainSlug}:${ytAddress.toLowerCase()}`,
          settlementAssetKey: tradeSide === "buy" ? tokenIn.address : tokenOut,
          meta: {
            protocol: "pendle",
            side: tradeSide,
            instrument: "yt",
            pendle: {
              marketAddress: market.address,
              ptAddress: market.pt,
              ytAddress: market.yt,
              syAddress: market.sy,
              underlyingAsset: market.underlyingAsset,
              expiry: market.expiry,
              ytSymbol: assetMap.get(ytAddress.toLowerCase())?.symbol ?? null,
              ytDecimals: assetMap.get(ytAddress.toLowerCase())?.decimals ?? null,
            },
          },
        },
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure(`pendle.yt.${tradeSide}`, txHash, err);
    return fail(`Pendle YT ${tradeSide} failed (${failureDetail(`pendle.yt.${tradeSide}`, err)})`);
  }
}

// ── Claim (income sweep — YT interest + rewards, LP rewards) ──────────

async function pendleClaim(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain");
  if (!chain) return fail("Missing required: chain");
  const marketParam = str(p, "market");
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");

    const targets = await buildPendleClaimTargets(
      chainId, wallet, marketParam ? requireTokenAddress(marketParam) : null,
    );
    const { intendedYts, intendedMarkets } = targets;
    const skipNote = describePendleClaimSkips(targets);
    if (intendedYts.size === 0 && intendedMarkets.size === 0) {
      return ok({
        claimed: false, chain: chainSlug,
        reason: skipNote ?? "no Pendle YT/LP positions to claim on this chain",
        eligibleMarkets: targets.eligibleMarketCount,
      });
    }

    // Every claim states what it is NOT claiming (eligible total + the exact
    // markets left out) — a sweep that silently stops at its cap is a lie by
    // omission when the manifest says "every held market".
    if (p.dryRun === true) {
      return ok({
        dryRun: true, chain: chainSlug,
        yts: intendedYts.size, markets: intendedMarkets.size,
        eligibleMarkets: targets.eligibleMarketCount,
        selectedMarkets: targets.selectedMarketCount,
        marketCap: targets.marketCap,
        skippedMarkets: targets.skipped,
        ...(skipNote ? { skippedNote: skipNote } : {}),
      });
    }

    // Signer AFTER dryRun so a preview never decrypts a key.
    let signer: ChainWallet;
    try {
      signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
    const signerAddr = getAddress(signer.address);

    const response = await getPendleClient().redeemInterestsAndRewards(chainId, {
      receiver: signerAddr,
      yts: [...intendedYts.keys()],
      markets: [...intendedMarkets],
    });
    if (!response) return fail("Pendle returned no claim transaction for these positions.");

    // FULL fund-safety bind (Router pin, value 0, SYs/swaps empty, pendleSwap
    // pinned, tuples bound to OUR resolved underlying, YTs/markets ⊆ intended,
    // approvals restricted to intended SYs). Nothing is signed unless every
    // check passes.
    const intent: PendleClaimIntent = { wallet: signerAddr, intendedYts, intendedMarkets };
    const claim = assertClaimSafe(intent, response);

    // Codex: never broadcast an all-empty effective claim — nothing is accruing.
    if (claim.yts.length === 0 && claim.markets.length === 0) {
      return ok({ claimed: false, chain: chainSlug, reason: "no accrued interest or rewards to claim right now" });
    }

    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    // Grant EXACTLY the validated SY approvals (source-verified: the Router pulls
    // the freshly-redeemed SY interest from the wallet — ActionMiscV3.sol:124).
    // `assertClaimSafe` already restricted these to the intended markets' SYs;
    // the spender is hard-pinned to the Router inside ensurePendleAllowanceExact.
    for (const approval of response.tokenApprovals) {
      await ensurePendleAllowanceExact(publicClient, walletClient, getAddress(approval.token), PENDLE_ROUTER, BigInt(approval.amount));
    }
    const txHash = await walletClient.sendTransaction({
      account: walletClient.account,
      chain: walletClient.chain,
      to: getAddress(response.tx.to),
      data: response.tx.data as Hex,
      value: 0n,
    });

    const claimedYts = claim.yts.map((t) => t.yt.toLowerCase());
    const claimedMarkets = claim.markets.map((a) => a.toLowerCase());
    logger.info("pendle.claim.executed", { chain: chainSlug, yts: claimedYts.length, markets: claimedMarkets.length });

    return {
      success: true,
      output: JSON.stringify({
        txHash, claimed: true, chain: chainSlug,
        yts: claimedYts, markets: claimedMarkets,
        eligibleMarkets: targets.eligibleMarketCount,
        claimedMarkets: targets.selectedMarketCount,
        marketCap: targets.marketCap,
        skippedMarkets: targets.skipped,
        ...(skipNote ? { skippedNote: skipNote } : {}),
      }, null, 2),
      data: {
        txHash,
        _tradeCapture: {
          // Income sweep — an audit-style record (type "reward", status "claimed"),
          // no input/output token pair to value. `chain` resolves selective sync.
          type: "reward",
          chain: chainSlug,
          status: "claimed",
          walletAddress: signerAddr,
          signature: txHash,
          meta: {
            protocol: "pendle",
            action: "claim",
            chain: chainSlug,
            claimedYts,
            claimedMarkets,
          },
        },
      },
    };
  } catch (err) {
    return fail(`Pendle claim failed (${failureDetail("pendle.claim", err)})`);
  }
}

export const PENDLE_YT_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.yt.quote": (p, ctx) => pendleYtQuote(p, ctx),
  "pendle.yt.buy": (p, ctx) => executePendleYtSwap(p, "yt-buy", ctx),
  "pendle.yt.sell": (p, ctx) => executePendleYtSwap(p, "yt-sell", ctx),
  "pendle.claim": (p, ctx) => pendleClaim(p, ctx),
};
