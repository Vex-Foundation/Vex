/**
 * Approval-enqueue helpers - the fail-fast actionKind guard and the turn
 * loop's binding of the shared enqueue transaction.
 *
 * The transaction itself MOVED to `approval-runtime/enqueue.ts` when the Vex
 * Studio MCP surface became its second caller. Nothing about the turn loop's
 * behaviour moved with it: this module still owns the fail-fast guard, still
 * produces the same narrow record from the `EngineContext`, and still passes
 * the pre-insert gate it always ran (session control lock, then the operator
 * stop gate). The orchestrator keeps owning the approval-path ORDER
 * (dispatch -> actionKind fail-fast -> executedCalls.push -> SINGLE DB
 * transaction -> break).
 */

import type { EngineContext } from "../../types.js";
import type { ParsedToolCall } from "@vex-agent/inference/types.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { ActionKind } from "@vex-agent/tools/taxonomy.js";
import {
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import {
  enqueueApprovalIntentWithGate,
  type ApprovalEnqueueOutcome as SharedEnqueueOutcome,
} from "../approval-runtime/enqueue.js";
import type { IntentPreview } from "../approval-intent-preview.js";

/**
 * Approval-path fail-fast. Puzzle 5 phase 2: approval_intents.action_kind is
 * NOT NULL with a CHECK constraint over the 8 canonical ActionKind variants.
 * The dispatcher's `withActionKindFallback` MUST have stamped a kind before
 * this branch - a missing stamp here is a bug in tool registration or in the
 * dispatcher fallback. Fail fast (Codex 2/1B ruling) instead of silently
 * inserting a pseudo-kind or downgrading to a default - neither preserves the
 * policy invariant. Returns the validated kind so the enqueue path reads a
 * narrowed `ActionKind`.
 */
export function assertApprovalActionKind(
  result: ToolResult,
  toolCall: ParsedToolCall,
): ActionKind {
  if (result.actionKind === undefined) {
    throw new Error(
      `Approval intent requires result.actionKind for tool "${toolCall.name}" - ` +
      `dispatcher fallback should have stamped it. ` +
      `Check the tool's actionKind classification in tools/registry/ or protocols/.`,
    );
  }
  return result.actionKind;
}

/**
 * Outcome of the enqueue transaction, as the turn loop consumes it.
 *
 * `auto_rejected` closes the restricted-mode stop race: a tool can still be
 * in flight when the operator stops the run, so by the time it comes back
 * asking for approval the run may be terminal - or a `stop_terminal` request
 * may be queued and not yet applied. Enqueueing in either case would park a
 * live, approvable action on a run nobody will ever resume. The row is still
 * written (audit trail) but immediately rejected in the SAME transaction, and
 * the run status is NOT flipped to `paused_approval`.
 *
 * The shared transaction also models a `refused` verdict, which the turn
 * loop's gate can never produce: the operator-stop gate either clears or
 * auto-rejects, and both write the audit row. It is excluded from this type
 * rather than mapped, so a future turn-loop gate that could refuse has to say
 * so here first.
 */
export type ApprovalEnqueueOutcome = Exclude<
  SharedEnqueueOutcome,
  { kind: "refused" }
>;

/**
 * Bind the turn loop's inputs and its pre-insert gate to the shared enqueue
 * transaction.
 */
export async function enqueueApprovalIntent(args: {
  readonly context: EngineContext;
  readonly toolCall: ParsedToolCall;
  readonly result: ToolResult;
  readonly toolContext: InternalToolContext;
  readonly intentActionKind: ActionKind;
  /**
   * Handler-authored preview for a registry-validated prepared follow-up
   * (`resolvePreparedActionFollowUp`). When present it REPLACES the
   * args-derived preview entirely.
   */
  readonly trustedPreview?: IntentPreview;
  /** Optional prepared-action expiry; approval must not outlive it. */
  readonly trustedExpiresAt?: string;
}): Promise<ApprovalEnqueueOutcome> {
  const { context, toolCall } = args;
  const outcome = await enqueueApprovalIntentWithGate(
    {
      sessionId: context.sessionId,
      missionId: context.missionId,
      missionRunId: context.missionRunId,
      permission: context.sessionPermission,
      toolName: toolCall.name,
      toolArgs: toolCall.arguments,
      toolCallId: toolCall.id,
      result: args.result,
      toolContext: args.toolContext,
      intentActionKind: args.intentActionKind,
      ...(args.trustedPreview === undefined
        ? {}
        : { trustedPreview: args.trustedPreview }),
      ...(args.trustedExpiresAt === undefined
        ? {}
        : { trustedExpiresAt: args.trustedExpiresAt }),
      // The binding is read off the RESULT, never taken as a parameter: only
      // the handler that rebuilt it from the durable proposal row may say what
      // an approval is bound to (stage A4b, spec item 2).
      ...(args.result.preparedApprovalBinding === undefined
        ? {}
        : { preparedApprovalBinding: args.result.preparedApprovalBinding }),
      origin: "agent",
    },
    // Restricted-mode stop race: the operator can stop the run WHILE this tool
    // is in flight. A row-lock re-check alone is not enough - it proves the run
    // was not terminal, not that the operator had not pressed Stop, and a
    // `stop_terminal` request that has not been INSERTED yet cannot be locked.
    // The session control lock is that boundary; the gate then applies a queued
    // stop through the one shared stop body so we never enqueue an approvable
    // action onto a run the user has already given up on.
    async (client) => {
      await acquireSessionControlLock(client, context.sessionId);
      const stopGate = await gateOnOperatorStopWithClient(client, {
        sessionId: context.sessionId,
        missionRunId: context.missionRunId ?? null,
      });
      if (stopGate.kind === "stopped") {
        return {
          kind: "auto_rejected",
          runStatus: stopGate.runStatus,
          logKind: "operator_stop",
        };
      }
      return { kind: "clear" };
    },
  );
  if (outcome.kind === "refused") {
    // Unreachable: the gate above never refuses. Named rather than cast so a
    // future gate change fails here instead of silently losing an approval.
    throw new Error(
      `Turn-loop approval enqueue refused unexpectedly: ${outcome.reason}`,
    );
  }
  return outcome;
}
