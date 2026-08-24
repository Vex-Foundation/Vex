/**
 * How `kyberswap.swap.execute` finalizes `agent_activity` rows on a failure —
 * the three writes whose ordering and best-effort semantics were won by
 * incident review, kept together so a future change cannot alter one and leave
 * the others inconsistent.
 */

import logger from "@utils/logger.js";
import {
  createAgentActivityPreBroadcastFailure,
  failActivityEvent,
  abortPlannedEvents,
  type AgentActivityEvent,
  type AgentActivityFailureCode,
  type AgentActivityLegInput,
} from "@vex-agent/db/repos/agent-activity.js";
import type { ResolvedKyberTokenMetadata } from "@tools/kyberswap/helpers.js";
import { mapKyberFailureToActivityCode } from "../../failure-mapping.js";
import type { ToolResult } from "../../../../types.js";
import { kyberFailureMessage } from "./error-output.js";
import { PROTOCOL } from "./protocol-id.js";
import { venueFallbackNoteOnFailure } from "./fallback-messaging.js";

/** A route/validation failure before anything could be signed — hashless `definitively_failed` row. */
export async function failPreBroadcast(
  toolId: string,
  p: Record<string, unknown>,
  sessionId: string,
  walletAddress: string,
  chainId: number,
  chainSlug: string,
  tokenIn: AgentActivityLegInput | undefined,
  tokenOut: AgentActivityLegInput | undefined,
  err: unknown,
  tokenInputsValidated: boolean,
): Promise<ToolResult> {
  const failureCode = mapKyberFailureToActivityCode(err);
  const failureReason = kyberFailureMessage(toolId, err);
  const { executionId } = await createAgentActivityPreBroadcastFailure({
    toolId,
    namespace: PROTOCOL,
    intentParams: p,
    event: {
      eventIndex: 0,
      eventRole: "swap",
      kind: "swap",
      protocol: PROTOCOL,
      chainId,
      chainSlug,
      walletAddress,
      sessionId,
      tokenIn,
      tokenOut,
      failureCode,
      failureReason,
    },
  });
  const fallbackNote = venueFallbackNoteOnFailure(err, sessionId, tokenInputsValidated);
  return {
    success: false,
    output: `${toolId} failed: ${failureReason}.${fallbackNote}`,
    data: { _executionId: executionId },
  };
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
 * `reason` must be the bare descriptive tail, WITHOUT a "not attempted:"
 * prefix — `abortPlannedEvents` itself owns adding that prefix exactly once
 * (Codex final-review round 2, finding 9 / C36; see
 * `agent-activity.ts`'s `abortPlannedEvents` doc comment).
 */
export async function abortRemainingPlans(executionId: number, fromIndex: number, reason: string): Promise<void> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
  } catch (err) {
    logger.warn("kyberswap.swap.execute.abort_planned_events_failed", {
      executionId,
      fromIndex,
      error: kyberFailureMessage("kyberswap.swap.execute", err),
    });
  }
}

/**
 * Finalize the ONE leg the chain refused pre-sign with its real failure code,
 * instead of the blanket `unknown` that `abortPlannedEvents` hardcodes — a row
 * reading `FAIL[unknown]` for a diagnosable slippage revert tells the agent
 * nothing it can act on. Mirrors what `uniswap.swap.execute` already does from
 * its sign-time catch.
 *
 * Called BEFORE the abort sweep because `failActivityEvent`'s CAS requires
 * `status = 'pending'`, and as a SUPPLEMENT to it, never a replacement: the
 * sweep still runs and its own `pending` filter skips this row, so a failed
 * write here can never strand a row. Best-effort for that reason — a throw is
 * logged, never propagated (the caller's return value is already decided).
 */
export async function failRefusedLeg(
  eventRow: AgentActivityEvent | undefined,
  failureCode: AgentActivityFailureCode,
  reason: string,
): Promise<void> {
  if (!eventRow) return;
  try {
    await failActivityEvent(eventRow.id, { failureCode, failureReason: `refused before signing: ${reason}` });
  } catch (err) {
    logger.warn("kyberswap.swap.execute.refused_leg_fail_write_failed", {
      id: eventRow.id,
      error: kyberFailureMessage("kyberswap.swap.execute", err),
    });
  }
}

export function legInput(token: ResolvedKyberTokenMetadata): AgentActivityLegInput {
  return {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
  };
}
