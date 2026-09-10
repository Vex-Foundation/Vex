/**
 * What happens once the swap leg is CONFIRMED on-chain:
 * auto-pin the acquired token, decode the executed amounts from the receipt,
 * and record them.
 *
 * Nothing in here may turn a confirmed swap into a failure. The swap DID
 * settle; a decoder throw or a bookkeeping write that did not land is reported
 * through `status`, never through `success`.
 */

import { readV4SettlementTransaction } from "@tools/uniswap/v4-settlement.js";
import { nativeBalanceRpc, readV4NativeBalanceEvidence, NATIVE_BALANCE_BOUND_SOURCE } from "@tools/uniswap/v4-native-balance.js";
import { recordV4NativeSettlement } from "@vex-agent/db/repos/agent-activity.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { describeV4Route, v4QuoteWarning } from "@tools/uniswap/v4-pool.js";
import type { UniswapExecutionSnapshot } from "../../../quote-authority/uniswap.js";
import { formatUnits, getAddress, zeroAddress, type Hex } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { assessApprovedFloor, verifyPostBuyDelivery } from "@tools/evm-chains/post-buy-delivery.js";
import type { Erc20ReadClient } from "@tools/evm-chains/erc20-reads.js";
import { decodeUniswapExecutedLegs, type UniswapDecodableReceipt } from "@tools/uniswap/receipt-decoder.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken } from "@tools/uniswap/types.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import { confirmActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";

import type { ToolResult } from "../../../../types.js";
import { TOOL_ID } from "./protocol-id.js";
import { uniswapFailureMessage } from "./error-output.js";
import type { QuotedRoute } from "./route-quote.js";

export interface FinalizeConfirmedSwapInput {
  readonly eventId: number;
  readonly executionId: number;
  readonly sessionId: string;
  readonly deployment: UniswapDeployment;
  readonly walletAddress: string;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  readonly quoted: QuotedRoute;
  /** The floor the approved quote authorized, for the post-settlement assessment. */
  readonly approvedMinOutRaw: string;
  readonly approvedSnapshot?: UniswapExecutionSnapshot;
  readonly receipt: UniswapDecodableReceipt;
  readonly txHash: Hex;
  /** Read-only client for the post-buy delivery check. */
  readonly publicClient: Erc20ReadClient;
}

export interface FinalizeConfirmedSwapOutcome {
  readonly feeInputBoundRaw?: string;
  readonly result: ToolResult;
  /**
   * The object behind `result.output` when the settlement decoded, so the fee
   * attacher can add its disclosure to the SAME JSON instead of re-parsing a
   * string it just serialized. `null` on the undecodable branch, whose output is
   * prose.
   */
  readonly outputPayload: Record<string, unknown> | null;
}

export async function finalizeConfirmedSwap(x: FinalizeConfirmedSwapInput): Promise<FinalizeConfirmedSwapOutcome> {
  const { deployment, tokenIn, tokenOut, executionId, txHash } = x;

  // Auto-pin (fail-soft) - Codex final-review round 4, finding 3: runs
  // IMMEDIATELY after on-chain confirmation, BEFORE decoding, so a
  // confirmed-but-undecodable settlement can never skip it. The spent
  // token-in is never pinned. Never allowed to fail the swap result.
  if (getLocalChain(deployment.chainId) && !tokenOut.isNative) {
    try {
      await pinTrackedToken({
        walletAddress: x.walletAddress, chainId: deployment.chainId,
        tokenAddress: tokenOut.address, source: "swap",
      });
    } catch (err) {
      logger.warn("uniswap.swap.execute.auto_pin_failed", {
        chain: deployment.key, error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  // A1: ask the acquired token what the wallet actually holds. Receipt logs
  // are contract-authored, so a fake-transfer token can settle decodably and
  // deliver nothing (live TOM incident 2026-08-10). Same gate as the auto-pin
  // above: local chain, acquired ERC-20. Fail-soft in every direction.
  const deliveryVerdict = getLocalChain(deployment.chainId) && !tokenOut.isNative
    ? await verifyPostBuyDelivery({
        client: x.publicClient,
        tokenAddress: getAddress(tokenOut.address),
        owner: getAddress(x.walletAddress),
        chainLabel: deployment.key,
        txHash,
      })
    : null;

  // C38 (Codex final-review round 3, finding 2): the swap ALREADY
  // confirmed on-chain at this point - a throw from the decoder itself
  // must NEVER escape to the generic outer post-intent catch (C18), which
  // returns a result WITHOUT the tx hash and would silently lose the
  // known hash for a swap that genuinely succeeded. Treat a throw exactly
  // like a fully-undecoded receipt (falls through to the SAME
  // `confirmed_pending_amounts` branch below, which already preserves the
  // tx hash) - mirrors Kyber's identical defensive catch around its own
  // settlement decoder.
  let decoded: ReturnType<typeof decodeUniswapExecutedLegs>;
  try {
    decoded = decodeUniswapExecutedLegs({
      receipt: x.receipt,
      chainId: deployment.chainId,
      walletAddress: x.walletAddress,
      version: x.quoted.route.version,
      ...(x.quoted.route.version === "v4" ? { v4Binding: x.quoted.route.v4,
        ...((tokenIn.isNative || tokenOut.isNative) ? { v4Transaction: await readV4SettlementTransaction(getUniswapPublicClient(deployment), txHash) } : {}),
        ...((tokenIn.isNative || (tokenOut.isNative && x.quoted.route.v4.poolKey.hooks.toLowerCase() === zeroAddress)) ? { nativeBalance: await readV4NativeBalanceEvidence(
          nativeBalanceRpc(getUniswapPublicClient(deployment)), { chainId: deployment.chainId,
            wallet: x.walletAddress, txHash, router: x.quoted.route.v4.universalRouter }) } : {}),
      } : {}),
      tokenInAddress: tokenIn.isNative ? null : tokenIn.address,
      tokenOutAddress: tokenOut.isNative ? null : tokenOut.address,
    });
  } catch (err) {
    logger.warn("uniswap.swap.execute.settlement_decode_threw", {
      id: x.eventId, txHash, error: uniswapFailureMessage(err),
    });
    decoded = {};
  }

  if (decoded.executedAmountInRaw === undefined || decoded.executedAmountOutRaw === undefined) {
    if (decoded.executedAmountInRaw !== undefined && decoded.v4Settlement?.pendingReason === "native_output_unproven_hooked"
      && x.quoted.route.version === "v4") {
      let status = "confirmed";
      try {
        await recordV4NativeSettlement({ id: x.eventId, chainId: deployment.chainId, txHash,
          poolId: x.quoted.route.v4.poolId, amountInRaw: decoded.executedAmountInRaw.toString(),
          inputIsBound: false, outputUnproven: true, poolOutputEstimateRaw: decoded.v4Settlement.poolAmountOutRaw });
      } catch { status = "confirmed_unrecorded"; }
      const outputPayload = { txHash, chain: deployment.key, chainId: deployment.chainId, status,
        pendingReason: "native_output_unproven_hooked", amountOut: null,
        amountIn: formatUnits(decoded.executedAmountInRaw, tokenIn.decimals),
        tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol,
        outputEstimateRaw: decoded.v4Settlement.poolAmountOutRaw ?? null,
        settlementNote: "The swap confirmed and its ERC-20 input is proven. Native output is unproven; the pool output is an estimate, not a received amount.",
        route: { version: "v4", path: x.quoted.route.path, ...x.quoted.route.v4,
          description: describeV4Route(x.quoted.route.v4), quoteWarning: v4QuoteWarning(x.quoted.route.v4) },
        quotedAmountOut: x.approvedSnapshot?.approvedAmountOutHuman, minAmountOut: x.approvedSnapshot?.approvedMinOutHuman,
        slippageBps: x.quoted.slippageBps, recipient: x.walletAddress, preSignFee: x.quoted.v4FeeObservation,
        inputDecimals: tokenIn.decimals, outputDecimals: tokenOut.decimals,
        approvedAmountInRaw: x.approvedSnapshot?.totalInRaw,
        spenderDescription: `Permit2 and Uniswap UniversalRouter ${x.quoted.route.v4.universalRouterVersion}`,
        deadline: "600 seconds from signing", consequence: "Spends real funds irreversibly after confirmation" };
      return { outputPayload, result: { success: true, output: JSON.stringify(outputPayload, null, 2),
        data: { txHash, _executionId: executionId, status } } };
    }
    logger.warn("uniswap.swap.execute.settlement_undecodable", { id: x.eventId, txHash });
    // Migration 067: mined SUCCESSFULLY, amounts unreadable. Distinct from "we
    // never saw the receipt", and the distinction is what lets the fallback
    // route work instead of guessing which job this row needs.
    await noteHandlerPendingReason("uniswap.swap.execute", x.eventId, "settlement_undecodable");
    if (x.quoted.route.version === "v4") {
      const outputPayload = {
        txHash, chain: deployment.key, chainId: deployment.chainId,
        status: "confirmed_pending_amounts",
        settlementNote: "Swap confirmed; the receipt does not prove both executed amounts. No executed amount was guessed.",
        settlementEvidence: decoded.v4Settlement,
        preSignFee: x.quoted.v4FeeObservation,
        route: { version: "v4", path: x.quoted.route.path, ...x.quoted.route.v4,
          description: describeV4Route(x.quoted.route.v4), quoteWarning: v4QuoteWarning(x.quoted.route.v4) },
        tokenIn: { symbol: tokenIn.symbol, decimals: tokenIn.decimals },
        tokenOut: { symbol: tokenOut.symbol, decimals: tokenOut.decimals },
        approvedAmountInRaw: x.approvedSnapshot?.totalInRaw,
        quotedAmountOut: x.approvedSnapshot?.approvedAmountOutHuman,
        minAmountOut: x.approvedSnapshot?.approvedMinOutHuman,
        slippageBps: x.quoted.slippageBps, recipient: x.walletAddress,
        spenderDescription: `Permit2 and Uniswap UniversalRouter ${x.quoted.route.v4.universalRouterVersion}`,
        deadline: "600 seconds from signing", consequence: "Spends real funds irreversibly after confirmation",
      };
      return { outputPayload, result: { success: true, output: JSON.stringify(outputPayload, null, 2), data: { txHash, _executionId: executionId, status: "confirmed_pending_amounts" } } };
    }
    return {
      outputPayload: null,
      result: {
        success: true,
        output: `${TOOL_ID}: swap confirmed on-chain (tx ${txHash}) but the executed amounts could not be decoded yet - check the transaction hash for the exact amounts. The record will finalize automatically.${deliveryVerdict ? ` ${deliveryVerdict}` : ""}`,
        data: { txHash, _executionId: executionId, status: "confirmed_pending_amounts" },
      },
    };
  }

  // C34 (Codex final-review round 2, finding 6): the DECODED net
  // settlement amount, never the request echo (`amountInRaw`, the raw
  // requested-string param) - a fee-on-transfer token or partial fill can
  // make the executed input differ from what was requested, and the
  // success message must never contradict the persisted `agent_activity`
  // truth.
  let amountInHuman = formatUnits(decoded.executedAmountInRaw, tokenIn.decimals);
  const amountOutHuman = formatUnits(decoded.executedAmountOutRaw, tokenOut.decimals);
  const inputIsBound = decoded.v4Settlement?.evidenceSource === NATIVE_BALANCE_BOUND_SOURCE;
  let status: "confirmed" | "confirmed_unrecorded";
  if (inputIsBound && x.quoted.route.version === "v4") {
    try {
      const row = await recordV4NativeSettlement({ id: x.eventId, chainId: deployment.chainId, txHash,
        poolId: x.quoted.route.v4.poolId, amountInRaw: decoded.executedAmountInRaw.toString(),
        amountOutRaw: decoded.executedAmountOutRaw.toString(), inputIsBound: true, outputUnproven: false });
      if (row.executedAmountInRaw !== null) decoded = { ...decoded, executedAmountInRaw: BigInt(row.executedAmountInRaw) };
      amountInHuman = row.executedAmountInHuman ?? amountInHuman;
      status = "confirmed";
    } catch { status = "confirmed_unrecorded"; }
  } else status = await recordExecutedAmounts(x.eventId, {
    executedAmountInHuman: amountInHuman,
    executedAmountInRaw: decoded.executedAmountInRaw.toString(),
    executedAmountOutHuman: amountOutHuman,
    executedAmountOutRaw: decoded.executedAmountOutRaw.toString(),
  });

  logger.info("uniswap.swap.executed", { chain: deployment.key, version: x.quoted.route.version });

  // DETECTION, after the fact. The execute already refused to sign calldata
  // carrying any floor but the approved one, so a shortfall here means the fill
  // itself missed it - a taxing output token, or a router that under-delivered.
  // It never changes the settlement status; it changes what the agent is told.
  const floorAssessment = assessApprovedFloor({
    executedAmountOutRaw: decoded.executedAmountOutRaw,
    approvedMinOutRaw: x.approvedMinOutRaw,
    tokenOutSymbol: tokenOut.symbol,
  });
  if (floorAssessment.kind === "materially_short") {
    logger.warn("uniswap.swap.execute.fill_below_approved_floor", {
      id: x.eventId,
      txHash,
      shortfallRaw: floorAssessment.shortfallRaw.toString(),
    });
  }

  const outputPayload = {
    txHash, chain: deployment.key,
    ...(decoded.v4Settlement ? { settlementEvidence: decoded.v4Settlement } : {}),
    ...(x.quoted.v4FeeObservation ? { preSignFee: x.quoted.v4FeeObservation } : {}),
    tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol,
    amountIn: amountInHuman, amountOut: amountOutHuman,
    ...(inputIsBound ? { amountInBasis: "lower_bound", evidenceSource: NATIVE_BALANCE_BOUND_SOURCE,
      settlementNote: "Native input is a lower bound after gas and isolated-block checks. Same-block credits may make the actual spend higher." } : {}),
    route: { version: x.quoted.route.version, path: x.quoted.route.path,
      ...(x.quoted.route.version === "v4" ? { ...x.quoted.route.v4, description: describeV4Route(x.quoted.route.v4), quoteWarning: v4QuoteWarning(x.quoted.route.v4) } : {}) },
    ...(x.approvedSnapshot?.v4 ? {
      chainId: deployment.chainId, inputDecimals: tokenIn.decimals, outputDecimals: tokenOut.decimals,
      approvedAmountInRaw: x.approvedSnapshot.totalInRaw, approvedAmountIn: formatUnits(BigInt(x.approvedSnapshot.totalInRaw), tokenIn.decimals),
      quotedAmountOut: x.approvedSnapshot.approvedAmountOutHuman, minAmountOut: x.approvedSnapshot.approvedMinOutHuman,
      slippageBps: x.approvedSnapshot.slippageBps, recipient: x.approvedSnapshot.v4.recipient,
      spenderDescription: `Permit2 and Uniswap UniversalRouter ${x.approvedSnapshot.v4.route.universalRouterVersion}`,
      deadline: "600 seconds from signing", consequence: "Spends real funds irreversibly after confirmation",
    } : {}),
    ...(deliveryVerdict ? { deliveryCheck: deliveryVerdict } : {}),
    ...(floorAssessment.kind === "materially_short"
      ? { approvedFloorCheck: floorAssessment.verdict }
      : {}),
  };

  return {
    outputPayload,
    ...(inputIsBound ? { feeInputBoundRaw: decoded.executedAmountInRaw?.toString() } : {}),
    result: {
      success: true,
      output: JSON.stringify(outputPayload, null, 2),
      data: { txHash, _executionId: executionId, status },
    },
  };
}

/**
 * C16: the swap already confirmed on-chain - a DB write hiccup recording that
 * MUST NEVER read as the swap itself failing. `status` distinguishes
 * "confirmed" (our own record matches) from "confirmed_unrecorded" (on-chain
 * truth is settled; only our bookkeeping write failed) so a caller can tell the
 * two apart without this ever becoming a failure.
 */
async function recordExecutedAmounts(
  eventId: number,
  amounts: {
    readonly executedAmountInHuman: string;
    readonly executedAmountInRaw: string;
    readonly executedAmountOutHuman: string;
    readonly executedAmountOutRaw: string;
  },
): Promise<"confirmed" | "confirmed_unrecorded"> {
  try {
    const confirmResult = await confirmActivityEvent(eventId, amounts);
    // C41 (Codex final-review round 3, finding 6): a CAS MISS (the row
    // was no longer `pending`) is not automatically a success just
    // because nothing threw - a conflicting terminal row (e.g. a
    // concurrent repair-sweep write) must NOT be reported as an ordinary
    // confirmed swap. The one exception is a genuine idempotent retry:
    // the row is already `confirmed` with the SAME executed amounts this
    // call just computed - real recorded confirmation, not a conflict.
    if (!confirmResult.applied) {
      const alreadyRecorded = confirmResult.row.status === "confirmed"
        && confirmResult.row.executedAmountInRaw === amounts.executedAmountInRaw
        && confirmResult.row.executedAmountOutRaw === amounts.executedAmountOutRaw;
      if (!alreadyRecorded) {
        logger.warn("uniswap.swap.execute.confirm_cas_miss", {
          id: eventId, rowStatus: confirmResult.row.status,
        });
        return "confirmed_unrecorded";
      }
    }
    return "confirmed";
  } catch (err) {
    logger.warn("uniswap.swap.execute.confirm_failed", {
      id: eventId, error: uniswapFailureMessage(err),
    });
    return "confirmed_unrecorded";
  }
}
