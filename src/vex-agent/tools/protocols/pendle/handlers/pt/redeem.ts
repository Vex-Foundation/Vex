/**
 * `pendle.pt.redeem` — a MATURED PT back to its accounting asset.
 *
 * TWO PATHS, DELIVERING DIFFERENT ASSETS (P1-13). Convert's `redeemPyToToken`
 * pays the market's UNDERLYING; the API-independent `redeemPyToSy` fallback on
 * the pinned Router pays SY. Which asset arrived is decided before either branch
 * signs, so the durable row, the decoder and the model-facing result all name
 * the same token.
 *
 * EXIT PATH (R5b): the position this tool exists for is matured, so the market
 * is resolved through the EXIT resolver rather than the active-only one. The
 * fallback is GATED on proven maturity (P1-14) — `redeemPyToSy` burns PT alone,
 * which pre-expiry must revert.
 */

import { getAddress, parseUnits, type Address, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import type { PendleConvertResponse } from "@tools/pendle/types.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError } from "../../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { buildAssetMap } from "../../market-lookup.js";
import { resolveExitMarketByPt } from "../../matured-market-lookup.js";
import { selectSafeRoute, type PendleTxIntent } from "../../calldata.js";
import { assertPtMaturedForFallback, buildRedeemPyToSyPlan } from "../../redeem-fallback.js";
import { broadcastUnconfirmedFailure } from "../broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "../signed-broadcast.js";
import {
  failureDetail,
  humanAmount,
  legInput,
  requirePendleChain,
  resolveInputToken,
  resolvePendleSlippage,
  unsettledResult,
} from "../shared.js";

export async function executePendleRedeem(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
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
      const reason = "No Pendle market for this PT - cannot resolve YT/underlying for redeem. Check pendle__market_get, which reads matured markets too.";
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
        return fail("Pendle did not report this market's SY, so a direct redeem could not be recorded honestly. Retry, or use pendle__market_get to confirm the market.");
      }
      deliveredAsset = getAddress(market.sy);
      deliveredPath = "router_fallback_redeemPyToSy";
      // The floor needs the SY exchange rate (share-based SY — see
      // redeem-fallback.ts); built BEFORE the approval so a rate-read refusal
      // leaves no allowance behind.
      const plan = await buildRedeemPyToSyPlan({
        publicClient,
        receiver: wallet,
        yt: expectedYt,
        sy: deliveredAsset,
        netPyIn: amountWei,
        slippage: slippage.fraction,
      });
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
    }

    const deliveredNote = usedFallback
      ? "Redeemed via the Router fallback, which pays SY - NOT the market's underlying. The amount is the SY credit decoded from the receipt. To finish the exit, unwrap that SY with pendle__sy_redeem, passing this deliveredAsset as its `sy`."
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
        // NO `_tradeCapture`: this tool's durable truth is the `agent_activity` row
        // written by `sendPendleRouterTx`, so the legacy projection pipeline must
        // not also run for it (`mutation-matrix.ts`, `capture: "none"`).
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.pt.redeem", txHash, err);
    return fail(`Pendle redeem failed (${failureDetail("pendle__pt_redeem", err)})`);
  }
}
