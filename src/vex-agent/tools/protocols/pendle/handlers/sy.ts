/**
 * Pendle SY wrap / unwrap handlers (R5d card D3) - `pendle.sy.mint` (token → SY)
 * and `pendle.sy.redeem` (SY → token).
 *
 * ONE code path serves both directions: an SY wrap is symmetric, so the only
 * difference is which address is the input leg and which is the output leg.
 *
 * NO MARKET IS RESOLVED, and that is the honest shape rather than an omission.
 * The matured-market matrix (R5b) exists because a PT/YT/LP position belongs to
 * a market with an expiry, so a buy-shaped action must refuse a matured one by
 * name and an exit-shaped action must still reach it. An SY belongs to NO
 * market: it has no expiry, no PT and no YT (`calldata/decode.ts` - arg 1 of
 * `mintSyFromToken`/`redeemSyToToken` is the SY CONTRACT, not a market), so
 * there is nothing to classify and nothing to refuse. The SY the caller names is
 * instead bound directly into the calldata check (`expectedSy`), which is a
 * stronger guarantee than a catalogue lookup: the transaction cannot touch a
 * different SY than the one asked for.
 *
 * PREQUOTE - the DRY-RUN-IN-TOOL pattern. A `dryRun: true` call quotes through
 * Convert, runs the FULL fund-safety extractor (Router pin, sender/value binds,
 * exact approval-set bind, calldata intent bind, and the price floor), records
 * the authorization, and broadcasts nothing. The execute call re-fetches Convert,
 * re-runs every one of those checks, and is refused unless a fresh dry run with
 * IDENTICAL params exists. See `./sy-prequote.ts`.
 *
 * Upstream error text NEVER reaches the model - only bounded, code-keyed detail.
 */

import { getAddress, parseUnits, type Address, type Hex } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { getPendleEvmClients } from "@tools/pendle/evm-client.js";
import { ensurePendleAllowanceExact } from "@vex-agent/tools/protocols/pendle/allowance.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";
import { pendleSyTokenParamKey, type PendleSyDirection } from "../../prequote/identity/pendle-sy.js";

import { buildAssetMap } from "../market-lookup.js";
import { selectSafeRoute, type PendleTxIntent } from "../calldata.js";
import { broadcastUnconfirmedFailure } from "./broadcast-unconfirmed.js";
import { recordPendleRefusal, sendPendleRouterTx } from "./signed-broadcast.js";
import { gatePendleSyExecute, recordPendleSyPrequote } from "./sy-prequote.js";
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
} from "./shared.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

/** The activity role every SY row carries (migration 053) - one in, one out. */
const SY_EVENT_ROLE = "yield_sy" as const;

function toolIdFor(direction: PendleSyDirection): string {
  return direction === "mint" ? "pendle.sy.mint" : "pendle.sy.redeem";
}

async function executePendleSyWrap(
  p: Record<string, unknown>,
  direction: PendleSyDirection,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const toolId = toolIdFor(direction);
  // The plain-token leg is named for the DIRECTION it travels (SPEC §1.2 / W6e):
  // it is the INPUT on a mint (token → SY) and the OUTPUT on a redeem (SY →
  // token). One key for both would have named opposite legs on two money tools.
  const tokenKey = pendleSyTokenParamKey(direction);
  const chain = str(p, "chain"), syRaw = str(p, "sy"), tokenRaw = str(p, tokenKey), amountInRaw = str(p, "amountIn");
  if (!chain || !syRaw || !tokenRaw || !amountInRaw) {
    return fail(`Missing required: chain, sy, ${tokenKey}, amountIn (${toolId})`);
  }
  // Hoisted for the catch (pattern: `internal/wallet/send-execute-evm.ts`):
  // everything after the broadcast is a read-back that can throw, and the catch
  // MUST be able to tell the agent the wrap is already on-chain.
  let txHash: Hex | undefined;
  try {
    const chainEntry = requirePendleChain(chain);
    const chainId = chainEntry.chainId;
    const chainSlug = chainEntry.slug;
    // A mutation without a session has nothing to attribute its durable row to -
    // and nothing to scope its prequote to either.
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);

    // The INPUT leg is the one whose decimals feed parseUnits, so it is the one
    // read ON-CHAIN from the resolved chain's client. Native is refused here as
    // on every other Pendle mutating path.
    const inputRaw = direction === "mint" ? tokenRaw : syRaw;
    const outputRaw = direction === "mint" ? syRaw : tokenRaw;
    if (requireTokenAddress(syRaw) === requireTokenAddress(tokenRaw)) {
      return fail(`${toolId}: sy and ${tokenKey} must be different addresses.`);
    }
    const tokenIn = await resolveInputToken(chainEntry, inputRaw);
    const tokenOut = requireTokenAddress(outputRaw);
    const sy = direction === "mint" ? tokenOut : tokenIn.address;
    const amountWei = parseUnits(amountInRaw, tokenIn.decimals);
    const slippage = resolvePendleSlippage(toolId, num(p, "slippageBps"));

    /**
     * A refusal that happened before anything could be signed, recorded as a
     * hashless `definitively_failed` row so it is as visible in Agent Scan as a
     * fill - "nothing happened" must not be indistinguishable from "nothing was
     * recorded".
     */
    const refuse = async (
      failureCode: Parameters<typeof recordPendleRefusal>[1],
      message: string,
    ): Promise<ToolResult> => {
      await recordPendleRefusal(
        {
          toolId, eventRole: SY_EVENT_ROLE, chainId, chainSlug,
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

    const isDryRun = p.dryRun === true;

    // The prequote GATE runs before anything else on the execute path: a wrap
    // with no fresh dry run must not even reach Convert.
    if (!isDryRun) {
      const gate = await gatePendleSyExecute(toolId, sessionId, p, context, direction);
      if (gate.kind === "block") return refuse("route_not_found", gate.message);
    }

    // Signer resolution stays AFTER the dry-run branch decision so a preview
    // never decrypts a key. The dry run still binds the SELECTED address as the
    // receiver - the same address the execute will sign with - so its route
    // safety is the identical check, not a weaker one against a placeholder.
    let wallet: Address;
    let signer: ChainWallet | null = null;
    if (isDryRun) {
      wallet = getAddress(resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"));
    } else {
      try {
        signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
      } catch (err) {
        return walletScopeErrorToResult(err);
      }
      if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
      wallet = getAddress(signer.address);
    }

    const response = await getPendleClient().convert(chainId, {
      receiver: wallet,
      input: { token: tokenIn.address, amount: amountWei.toString() },
      outputToken: tokenOut,
      slippage: slippage.fraction,
    });
    if (!response || response.routes.length === 0) {
      return refuse("route_not_found", `Pendle returned no route for this SY ${direction}.`);
    }

    const intent: PendleTxIntent = {
      action: direction === "mint" ? "sy-mint" : "sy-redeem",
      wallet,
      // The tolerance this route is held to - see calldata/price-floor.ts.
      slippageBps: slippage.bps,
      inputToken: tokenIn.address,
      inputAmountWei: amountWei,
      isNative: false,
      expectedSy: sy,
      // The ONLY token this wrap may be quoted as delivering - the SY on a mint,
      // the payment token on a redeem. Without it a mint's `minSyOut` (a bare
      // uint256 naming no token) would be floored against whatever token the
      // response chose to declare, and `route.outputs[0]` below would report it.
      expectedRouteOutputs: [tokenOut],
      // Redeem carries a TokenOutput; binding it stops a route from delivering a
      // token other than the one quoted. Mint's SY output is arg 1, already bound
      // by `expectedSy`, and carries no output tuple.
      ...(direction === "redeem" ? { expectedOutputToken: tokenOut } : {}),
    };
    // FULL fund-safety extractor - identical on both the dry run and the execute.
    const route = selectSafeRoute(intent, response);

    const assetMap = await buildAssetMap(chainId);
    const quotedOutRaw = route.outputs[0]?.amount ?? "0";
    const outDecimals = assetMap.get(tokenOut.toLowerCase())?.decimals ?? null;
    const inHuman = humanAmount(amountWei, tokenIn.decimals);
    const quotedOutHuman = humanAmount(quotedOutRaw, outDecimals);

    if (isDryRun) {
      // Record ONLY after every safety check has passed: an unsafe route must
      // never leave an authorization behind.
      await recordPendleSyPrequote(toolId, sessionId, p, context, direction, {
        direction,
        sy,
        aggregator: route.data.aggregatorType ?? null,
      });
      return ok({
        dryRun: true,
        action: `sy.${direction}`,
        chainId,
        sy,
        tokenIn: tokenIn.address,
        tokenOut,
        amountIn: amountInRaw,
        quotedAmountOut: quotedOutHuman.toString(),
        priceImpact: route.data.priceImpact,
        feeUsdEstimate: route.data.feeUsd,
        aggregator: route.data.aggregatorType,
        slippageBps: num(p, "slippageBps") ?? VEX_DEFAULT_SLIPPAGE_BPS,
        note: "Nothing was broadcast. Call the same tool again with the EXACT same params (dryRun omitted or false) to execute.",
      });
    }

    // The dry-run branch returned above, so a signer exists here; the compiler
    // cannot see that across the branch, and a non-null assertion at a signing
    // boundary is exactly where an invariant should be checked rather than
    // asserted.
    if (signer === null) return fail(`${toolId}: no signing wallet resolved.`);
    const inUsd = legUsd(assetMap, tokenIn.address, inHuman);
    const quotedOutUsd = legUsd(assetMap, tokenOut, quotedOutHuman);

    // Approve EXACTLY the single required input token to the pinned Router.
    const { publicClient, walletClient } = getPendleEvmClients(chainId, signer.privateKey as Hex);
    await ensureErc20Balance(publicClient, {
      token: tokenIn.address,
      owner: wallet,
      required: amountWei,
      decimals: tokenIn.decimals,
    });
    await ensurePendleAllowanceExact(publicClient, walletClient, tokenIn.address, PENDLE_ROUTER, amountWei);

    const broadcast = await sendPendleRouterTx(
      publicClient,
      walletClient,
      // Never native: `resolveInputToken` refuses native input, so value is 0.
      { to: getAddress(route.tx.to), data: route.tx.data as Hex, value: 0n },
      {
        toolId,
        eventRole: SY_EVENT_ROLE,
        chainId, chainSlug, walletAddress: wallet, sessionId,
        intentParams: p,
        tokenIn: legInput(tokenIn.address, assetMap.get(tokenIn.address.toLowerCase())?.symbol, tokenIn.decimals, amountWei.toString(), inHuman.toString()),
        tokenOut: legInput(tokenOut, assetMap.get(tokenOut.toLowerCase())?.symbol, outDecimals, quotedOutRaw, quotedOutHuman.toString()),
        ...(inUsd !== null ? { usdInEst: String(inUsd) } : {}),
        ...(quotedOutUsd !== null ? { usdOutEst: String(quotedOutUsd) } : {}),
        routeProvenance: { aggregator: route.data.aggregatorType, syAddress: sy, direction },
      },
    );
    txHash = broadcast.txHash;
    if (broadcast.kind !== "confirmed") return unsettledResult(toolId, broadcast);

    // The RESULT is the decoded fill, never the quote. `quotedAmountOut` stays in
    // the output beside it so the agent can see the slippage it actually got.
    const executedOutRaw = broadcast.executed.amountOutRaw ?? quotedOutRaw;
    const executedInRaw = broadcast.executed.amountInRaw ?? amountWei.toString();

    logger.info("pendle.sy.executed", { direction, sy, aggregator: route.data.aggregatorType });

    return {
      success: true,
      output: JSON.stringify({
        txHash,
        action: `sy.${direction}`,
        sy,
        tokenIn: tokenIn.address,
        tokenOut,
        amountIn: amountInRaw,
        executedAmountIn: humanAmount(executedInRaw, tokenIn.decimals).toString(),
        executedAmountOut: humanAmount(executedOutRaw, outDecimals).toString(),
        quotedAmountOut: quotedOutHuman.toString(),
      }, null, 2),
      // NO `_tradeCapture`: this tool's durable truth is the `agent_activity` row
      // written by `sendPendleRouterTx`, so the legacy projection pipeline must
      // not also run for it (`mutation-matrix.ts`, `capture: "none"`).
      data: { txHash, _executionId: broadcast.executionId },
    };
  } catch (err) {
    if (txHash !== undefined) return broadcastUnconfirmedFailure(toolId, txHash, err);
    return fail(`Pendle SY ${direction} failed (${failureDetail(toolId, err)})`);
  }
}

export const PENDLE_SY_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.sy.mint": (p, ctx) => executePendleSyWrap(p, "mint", ctx),
  "pendle.sy.redeem": (p, ctx) => executePendleSyWrap(p, "redeem", ctx),
};
