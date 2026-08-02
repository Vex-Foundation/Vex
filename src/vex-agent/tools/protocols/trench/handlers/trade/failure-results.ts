/**
 * The two failure paths of `trench.trade_execute`, and the ToolResults they
 * produce.
 *
 * `preBroadcastFailure` covers everything that goes wrong BEFORE an intent
 * exists: it writes a durable pre-broadcast failure row so a refused trade is
 * still auditable. `handlePostIntentFailure` covers a throw AFTER the intent
 * exists: it finalizes the refused leg with its real failure code, aborts every
 * planned leg behind it — so a failed row can never strand as pending — and only
 * then returns.
 *
 * A leg that was already broadcast is never classified as a pre-sign refusal
 * (`legBroadcastAttempted`): the transaction may still settle, and calling it
 * "not attempted" would invite a retry that double-spends.
 */

import type { Address } from "viem";

import {
  DependentLegGasEstimateError,
  dependentLegEstimateGuidance,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { classifyPreSignRevert, preSignRefusalGuidance } from "@tools/evm-chains/pre-sign-revert-refusal.js";
import { TRENCH_MAX_SLIPPAGE_BPS } from "@tools/trench-express/evm/min-out.js";
import {
  createAgentActivityPreBroadcastFailure,
  failActivityEvent,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import { VexError } from "../../../../../../errors.js";
import type { ToolResult } from "../../../../types.js";
import type { TrenchTradeSide } from "@tools/trench-express/evm/curve-reader.js";
import { fail } from "../../../handler-helpers.js";
import type { TradeLegPlan } from "./plan.js";
import { CHAIN_SLUG, PROTOCOL, TOOL_ID, abortRemaining, safeDetail } from "./execute-identity.js";

export interface PostIntentFailureInput {
  readonly executionId: number;
  readonly events: readonly AgentActivityEvent[];
  readonly plans: readonly TradeLegPlan[];
  readonly slippageBps: number;
  readonly currentIndex: number;
  readonly legBroadcastAttempted: boolean;
  readonly error: unknown;
}

export async function handlePostIntentFailure(x: PostIntentFailureInput): Promise<ToolResult> {
  const { executionId, events, plans, currentIndex, legBroadcastAttempted, error: err } = x;
  const safeMessage = safeDetail(err);
  const refusedRole = plans[currentIndex]?.eventRole ?? "swap";
  // Finalize the refused leg with its real code (best-effort), then abort the
  // rest — before returning, so a failed row can never strand as pending.
  const preSignForRow = legBroadcastAttempted ? null : classifyPreSignRevert(err);
  if (preSignForRow && events[currentIndex]) {
    try {
      await failActivityEvent(events[currentIndex]!.id, {
        failureCode: preSignForRow.failureCode,
        failureReason: `refused before signing: ${safeDetail(preSignForRow.revertReason)}`,
      });
    } catch { /* best-effort */ }
  }
  await abortRemaining(executionId, currentIndex, safeMessage);

  if (err instanceof DependentLegGasEstimateError) {
    return {
      success: false,
      output: `${TOOL_ID}: the ${refusedRole} step could not be gas-estimated, so it was refused before signing. ${dependentLegEstimateGuidance(err)} Recorded as execution ${executionId}; nothing was signed for it.`,
      data: { _executionId: executionId, status: "not_attempted", retryable: true },
    };
  }
  const preSign = legBroadcastAttempted ? null : classifyPreSignRevert(err);
  if (preSign) {
    return {
      success: false,
      output: `${TOOL_ID}: the ${refusedRole} step was refused before signing. ${preSignRefusalGuidance({ revertReason: safeDetail(preSign.revertReason), failureCode: preSign.failureCode, slippage: { appliedBps: x.slippageBps, maxBps: TRENCH_MAX_SLIPPAGE_BPS } })} Recorded as execution ${executionId}.`,
      data: { _executionId: executionId, status: "not_attempted", retryable: true, failureCode: preSign.failureCode },
    };
  }
  return {
    success: false,
    output: `${TOOL_ID}: an internal error interrupted the trade after it was recorded — ${safeMessage}. Check the record (execution ${executionId}) before any further action.`,
    data: { _executionId: executionId, status: "pending" },
  };
}

export interface PreBroadcastFailureInput {
  readonly params: Record<string, unknown>;
  readonly sessionId: string;
  readonly walletAddress: Address;
  readonly chainId: number;
  readonly side: TrenchTradeSide;
  readonly token: Address;
  readonly nativeAddress: Address;
  readonly error: unknown;
}

export async function preBroadcastFailure(x: PreBroadcastFailureInput): Promise<ToolResult> {
  const { params, sessionId, walletAddress, chainId, side, token, nativeAddress, error: err } = x;
  const failureReason = safeDetail(err);
  const failureCode = err instanceof VexError ? "simulation_reverted" : "unknown";
  const tokenIn = side === "buy" ? { tokenAddress: nativeAddress, tokenSymbol: "ETH" } : { tokenAddress: token };
  const tokenOut = side === "buy" ? { tokenAddress: token } : { tokenAddress: nativeAddress, tokenSymbol: "ETH" };
  try {
    const { executionId } = await createAgentActivityPreBroadcastFailure({
      toolId: TOOL_ID,
      namespace: PROTOCOL,
      intentParams: params,
      event: { eventIndex: 0, eventRole: "swap", kind: "swap", protocol: PROTOCOL, chainId, chainSlug: CHAIN_SLUG, walletAddress, sessionId, tokenIn, tokenOut, failureCode, failureReason },
    });
    return { success: false, output: `${TOOL_ID} failed: ${failureReason}.`, data: { _executionId: executionId } };
  } catch (writeErr) {
    logger.warn("trench.trade_execute.pre_broadcast_write_failed", { error: safeDetail(writeErr) });
    return fail(`${TOOL_ID} failed: ${failureReason}.`);
  }
}
