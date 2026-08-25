/**
 * `pendle.claim` — the INCOME SWEEP (`redeemDueInterestAndRewardsV2`): accrued
 * YT interest + rewards and LP rewards for the wallet's positions on ONE chain,
 * in a single transaction.
 *
 * Which markets it sweeps — and which eligible ones the per-transaction cap
 * leaves out, always reported, never silent — is owned by `../../claim-targets.ts`.
 * There is nothing to quote (no prequote), but the claim is approval-gated,
 * Router-pinned, and FULL-decoded via `assertClaimSafe` before signing: funds
 * land on the wallet by protocol (no receiver arg exists), the only external-call
 * surface (`swaps`) is bound empty, and the ONLY allowance a claim may grant is
 * the market's own SY, exact-amount, to the pinned Router (source-verified: the
 * Router pulls the freshly-redeemed SY interest — ActionMiscV3.sol:117-126).
 */

import { getAddress, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@vex-agent/tools/protocols/pendle/allowance.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, ok, fail } from "../../../handler-helpers.js";

import { buildAssetMap } from "../../market-lookup.js";
import { buildPendleClaimTargets, describePendleClaimSkips } from "../../claim-targets.js";
import { assertClaimSafe, type PendleClaimIntent } from "../../calldata.js";
import { broadcastUnconfirmedFailure } from "../broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "../signed-broadcast.js";
import {
  failureDetail,
  humanAmount,
  requirePendleChain,
  requireTokenAddress,
  unsettledResult,
} from "../shared.js";

export async function pendleClaim(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain");
  if (!chain) return fail("Missing required: chain");
  const marketParam = str(p, "market");
  const toolId = "pendle.claim";
  // Hoisted OUT of every inner scope (H-4): once the node has a hash, the agent
  // must be told about it no matter what throws afterwards.
  let txHash: Hex | undefined;
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);
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
    if (!response) {
      const reason = "Pendle returned no claim transaction for these positions.";
      await recordPendleRefusal(
        { toolId, eventRole: "yield_claim", chainId, chainSlug, walletAddress: signerAddr, sessionId, intentParams: p },
        "route_not_found",
        reason,
      );
      return fail(reason);
    }

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
    /**
     * THE CREDIT ANCHOR. A claim has NO input leg — nothing is spent — so the
     * only evidence that it did anything is a decoded ERC-20 CREDIT to the
     * wallet, and the decoder needs a token to prove that credit against.
     *
     * A sweep can span up to `MAX_CLAIM_MARKETS` markets, but migration 053
     * binds the Option-C second-leg columns to `yield_py`/`yield_lp` ONLY, so a
     * claim row can name exactly ONE. It names the first DECODED tuple's
     * `tokenRedeemSy` — the market's underlying, and by `assertClaimSafe`'s own
     * bind the ONLY token the Router may redeem that SY into, i.e. exactly what
     * lands in the wallet (ActionMiscV3.sol:117-126).
     *
     * This deliberately UNDERSTATES: a multi-market sweep whose first market
     * accrued nothing stays `pending` even though a later one paid. That is the
     * fail-safe direction — an unproven claim reported as pending costs a
     * re-check, whereas a claim confirmed on an unproven credit is a fabricated
     * income record. Widening it needs a second-leg role binding, not a guess.
     */
    const assetMapForClaim = await buildAssetMap(chainId);
    const creditAnchor = claim.yts[0]?.tokenRedeemSy ?? null;
    const anchorSymbol = creditAnchor ? assetMapForClaim.get(creditAnchor.toLowerCase())?.symbol : undefined;
    const anchorDecimals = creditAnchor ? assetMapForClaim.get(creditAnchor.toLowerCase())?.decimals ?? null : null;

    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      { to: getAddress(response.tx.to), data: response.tx.data as Hex, value: 0n },
      {
        toolId, eventRole: "yield_claim", chainId, chainSlug, walletAddress: signerAddr, sessionId,
        intentParams: p,
        // NO tokenIn, ever: a claim spends nothing, and the finalizer rejects a
        // `yield_claim` confirmation that carries an executed input leg.
        ...(creditAnchor
          ? { tokenOut: { tokenAddress: creditAnchor, ...(anchorSymbol ? { tokenSymbol: anchorSymbol } : {}), ...(anchorDecimals !== null ? { tokenDecimals: anchorDecimals } : {}) } }
          : {}),
        routeProvenance: { action: "claim", claimedYtCount: claim.yts.length, claimedMarketCount: claim.markets.length },
      },
    );
    txHash = broadcast.txHash;
    // Receipt-success-with-zero-credits is NOT a successful claim: the sweep
    // moved nothing this run, and saying otherwise would book income that does
    // not exist. `unsettledResult` carries the honest `no_credit` wording.
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    const claimedRaw = broadcast.executed.amountOutRaw ?? "0";
    const claimedHuman = humanAmount(claimedRaw, anchorDecimals);
    const claimedYts = claim.yts.map((t) => t.yt.toLowerCase());
    const claimedMarkets = claim.markets.map((a) => a.toLowerCase());
    logger.info("pendle.claim.executed", { chain: chainSlug, yts: claimedYts.length, markets: claimedMarkets.length });

    return {
      success: true,
      output: JSON.stringify({
        txHash, claimed: true, chain: chainSlug,
        // The PROVEN credit, decoded from the receipt — and the one token it was
        // proven against, so "0.42" is never mistaken for the whole sweep.
        creditToken: creditAnchor,
        executedCredit: claimedHuman.toString(),
        yts: claimedYts, markets: claimedMarkets,
        eligibleMarkets: targets.eligibleMarketCount,
        claimedMarkets: targets.selectedMarketCount,
        marketCap: targets.marketCap,
        skippedMarkets: targets.skipped,
        ...(skipNote ? { skippedNote: skipNote } : {}),
      }, null, 2),
      data: {
        txHash,
        _executionId: broadcast.executionId,
        // NO `_tradeCapture`: this tool's durable truth is the `agent_activity` row
        // written by `sendPendleRouterTx`, so the legacy projection pipeline must
        // not also run for it (`mutation-matrix.ts`, `capture: "none"`).
      },
    };
  } catch (err) {
    // H-4: a throw AFTER the node returned a hash must never read as "nothing
    // happened" — the sweep may already be on-chain.
    if (txHash !== undefined) return broadcastUnconfirmedFailure(toolId, txHash, err);
    return fail(`Pendle claim failed (${failureDetail(toolId, err)})`);
  }
}
