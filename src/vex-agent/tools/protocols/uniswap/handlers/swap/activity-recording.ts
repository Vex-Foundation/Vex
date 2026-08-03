/**
 * The `agent_activity` writes that are NOT part of a staged broadcast: the
 * hashless pre-broadcast failure row, and the best-effort finalization of
 * planned events that were never signed.
 */

import {
  createAgentActivityPreBroadcastFailure,
  abortPlannedEvents,
  type CreatePendingActivityEventInput,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import { classifyPreBroadcastFailure } from "@tools/uniswap/revert-mapping.js";
import type { UniswapToken } from "@tools/uniswap/types.js";

import type { ToolResult } from "../../../../types.js";
import { TOOL_ID, PROTOCOL } from "./protocol-id.js";
import { uniswapFailureMessage } from "./error-output.js";

export type PlannedEvent = Omit<CreatePendingActivityEventInput, "protocolExecutionId">;

export function legFor(token: UniswapToken): NonNullable<PlannedEvent["tokenIn"]> {
  return token.isNative
    ? { tokenSymbol: token.symbol, tokenDecimals: token.decimals }
    : { tokenAddress: token.address, tokenSymbol: token.symbol, tokenDecimals: token.decimals };
}

/** A route/validation failure before anything could be signed — hashless `definitively_failed` row. NEVER called once the intent already exists (C18) — see `abortRemainingPlans` for that path. */
export async function failPreBroadcast(
  p: Record<string, unknown>,
  event: {
    chainId: number;
    chainSlug: string;
    walletAddress: string;
    sessionId: string;
    tokenIn?: UniswapToken;
    tokenOut?: UniswapToken;
  },
  err: unknown,
): Promise<ToolResult> {
  const failureCode = classifyPreBroadcastFailure(err).failureCode;
  const failureReason = uniswapFailureMessage(err);
  const { executionId } = await createAgentActivityPreBroadcastFailure({
    toolId: TOOL_ID,
    namespace: PROTOCOL,
    intentParams: p,
    event: {
      eventIndex: 0,
      eventRole: "swap",
      kind: "swap",
      protocol: PROTOCOL,
      chainId: event.chainId,
      chainSlug: event.chainSlug,
      walletAddress: event.walletAddress,
      sessionId: event.sessionId,
      ...(event.tokenIn ? { tokenIn: legFor(event.tokenIn) } : {}),
      ...(event.tokenOut ? { tokenOut: legFor(event.tokenOut) } : {}),
      failureCode,
      failureReason,
    },
  });
  return { success: false, output: `${TOOL_ID} failed: ${failureReason}.`, data: { _executionId: executionId } };
}

/**
 * Finalize every planned event from `fromIndex` onward that was NEVER signed
 * (C17 / Codex final-review finding 3) — an early return after an
 * ambiguous/reverted broadcast, or a post-intent failure, must not leave
 * downstream rows permanently `pending` with no `submit_attempted_at` (the
 * repair sweep's candidate query excludes exactly those rows forever).
 * Best-effort: a throw here is logged, never propagated — the caller has
 * already decided its own return value and must not flip to a misleading
 * result just because this bookkeeping call failed.
 *
 * Returns whether the cleanup actually applied, so a caller reporting on an
 * ALREADY-CONFIRMED leg can disclose the bookkeeping gap instead of implying
 * the audit rows were finalized.
 */
export async function abortRemainingPlans(executionId: number, fromIndex: number, reason: string): Promise<boolean> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
    return true;
  } catch (err) {
    logger.warn("uniswap.swap.execute.abort_planned_events_failed", {
      executionId,
      fromIndex,
      error: uniswapFailureMessage(err),
    });
    return false;
  }
}
