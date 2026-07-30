/**
 * Tool-batch outcome reduction — turns the discriminated outcome of
 * `processTurnToolBatch` into the turn loop's next step: either the loop's
 * terminal `TurnLoopResult` or "continue to the next iteration".
 *
 * Extracted verbatim from `turn-loop.ts`. The pause/stop arms each carry their
 * own post-batch side effect (wake park, plan-acceptance park, post-compact
 * bookkeeping, operator-instruction merge) and that mapping is a different
 * reason to change from the loop's state threading, so it owns its own file.
 *
 * Arm order is preserved exactly: approval → waiting_for_wake →
 * plan_acceptance_pause → engine_stop → compact_committed → normal complete.
 */

import type { ToolBatchOutcome } from "../turn-loop-tool-batch.js";
import type { TurnLoopResult } from "./state.js";
import { applyWaitingForWakePostBatch } from "../turn-loop-waiting-for-wake.js";
import { applyPlanAcceptancePausePostBatch } from "../turn-loop-plan-acceptance-pause.js";

export type ToolBatchStep =
  | { readonly kind: "return"; readonly result: TurnLoopResult }
  | { readonly kind: "continue" };

export async function applyToolBatchOutcome(args: {
  readonly batchOutcome: ToolBatchOutcome;
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly sessionPermission: "restricted" | "full";
  readonly runnerOwnerId: string | undefined;
  readonly currentTokenCount: number;
  readonly contextLimit: number;
  /** Running loop totals as of AFTER this batch was folded in. */
  readonly totalToolCalls: number;
  readonly pendingApprovals: string[];
  readonly lastText: string | null;
  readonly handlePostCompactBookkeeping: () => Promise<void>;
  readonly mergeOperatorInstructions: () => Promise<void>;
}): Promise<ToolBatchStep> {
  const { batchOutcome } = args;

  if (batchOutcome.kind === "approval_break") {
    args.pendingApprovals.push(batchOutcome.pendingApprovalId);
    return {
      kind: "return",
      result: {
        text: args.lastText,
        toolCallsMade: args.totalToolCalls,
        pendingApprovals: args.pendingApprovals,
        stopReason: "approval_required",
      },
    };
  }

  if (batchOutcome.kind === "waiting_for_wake") {
    await applyWaitingForWakePostBatch({
      sessionId: args.sessionId,
      missionRunId: args.missionRunId,
      currentTokenCount: args.currentTokenCount,
      contextLimit: args.contextLimit,
      sessionPermission: args.sessionPermission,
      ...(args.runnerOwnerId === undefined
        ? {}
        : { runnerOwnerId: args.runnerOwnerId }),
      handlePostCompactBookkeeping: args.handlePostCompactBookkeeping,
    });
    return {
      kind: "return",
      result: {
        text: batchOutcome.text,
        toolCallsMade: args.totalToolCalls,
        pendingApprovals: args.pendingApprovals,
        stopReason: "waiting_for_wake",
        stopPayload: batchOutcome.stopPayload,
      },
    };
  }

  if (batchOutcome.kind === "plan_acceptance_pause") {
    await applyPlanAcceptancePausePostBatch({
      sessionId: args.sessionId,
      missionRunId: args.missionRunId,
    });
    return {
      kind: "return",
      result: {
        text: batchOutcome.text,
        toolCallsMade: args.totalToolCalls,
        pendingApprovals: args.pendingApprovals,
        stopReason: "plan_acceptance_required",
        stopPayload: batchOutcome.stopPayload,
      },
    };
  }

  if (batchOutcome.kind === "engine_stop") {
    return {
      kind: "return",
      result: {
        text: batchOutcome.text,
        toolCallsMade: args.totalToolCalls,
        pendingApprovals: args.pendingApprovals,
        stopReason: batchOutcome.stopReason,
        // Kept unconditional (may be `undefined`) so the returned object shape
        // is bit-for-bit what the loop produced before this extraction.
        stopPayload: batchOutcome.stopPayload,
      },
    };
  }

  if (batchOutcome.kind === "compact_committed") {
    await args.handlePostCompactBookkeeping();
    return { kind: "continue" };
  }

  // Normal batch complete
  await args.mergeOperatorInstructions();
  return { kind: "continue" };
}
