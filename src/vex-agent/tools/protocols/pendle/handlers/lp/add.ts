/**
 * `pendle.lp.add` - deposit ONE payment token into a Pendle market and receive
 * the market's LP token (Convert action `add-liquidity`,
 * `addLiquiditySingleToken`). The MARKET address IS the LP token, and it is the
 * anchor bound end to end (instrument guard → identity → calldata).
 *
 * Fresh Convert re-fetch → `selectSafeRoute` fund-safety extractor (Router pin,
 * receiver == wallet, market == quoted, exact spend, EXACT approval set on the
 * input token) → exact allowance to the pinned Router → broadcast.
 * Approval- and prequote-gated (kind `lp_add`).
 *
 * ACTIVE-ONLY (R5b matrix): adding liquidity after expiry is impossible.
 */

import { getAddress, parseUnits, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@vex-agent/tools/protocols/pendle/allowance.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";

import { resolveMarketByAddress, buildAssetMap } from "../../market-lookup.js";
import { explainUnresolvedPendleMarket } from "../../matured-refusal.js";
import { selectSafeRoute, type PendleTxIntent } from "../../calldata.js";
import { broadcastUnconfirmedFailure } from "../broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "../signed-broadcast.js";
import {
  failureDetail,
  humanAmount,
  legInput,
  legUsd,
  requirePendleChain,
  requireTokenAddress,
  resolveInputToken,
  resolvePendleSlippage,
  unsettledResult,
} from "../shared.js";

export async function executePendleLpAdd(p: Record<string, unknown>, context: ProtocolExecutionContext): Promise<ToolResult> {
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
        receiver: PENDLE_ROUTER, // placeholder - dry-run never signs
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
      // The tolerance this route is held to - see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      inputToken: tokenIn.address,
      inputAmountWei: amountWei,
      isNative: tokenIn.isNative,
      // addLiquiditySingleToken carries the MARKET at arg 1 - bind it to the quote.
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
    // Read BEFORE signing - the staged row's legs need their decimals.
    const assetMap = await buildAssetMap(chainId);
    const quotedLpOut = route.outputs.find((o) => o.token.toLowerCase() === marketAddr.toLowerCase())?.amount ?? "0";
    const lpDec = assetMap.get(marketAddr.toLowerCase())?.decimals ?? 18;
    const quotedInUsd = legUsd(assetMap, tokenIn.address, humanAmount(amountWei, tokenIn.decimals));

    // SINGLE-TOKEN add is the shipped shape - one in, one out. The Option-C
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
        // NO `_tradeCapture`: this tool's durable truth is the `agent_activity` row
        // written by `sendPendleRouterTx`, so the legacy projection pipeline must
        // not also run for it (`mutation-matrix.ts`, `capture: "none"`).
      },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure("pendle.lp.add", txHash, err);
    return fail(`Pendle add liquidity failed (${failureDetail("pendle__lp_add", err)})`);
  }
}
