/**
 * Approvals IPC — decision handlers (`approve` / `reject`).
 *
 * Puzzle 5 phase 3 — each handler:
 *
 *   1. Calls `ensureEngineDbUrl(ctx.requestId)` so the lazy `pg` pool used
 *      by the engine reaches the same Postgres the read handlers'
 *      `withClient` paths already use (mission/start.ts pattern).
 *   2. Runs the bounded prepare path (`prepareApprove` / `prepareReject`):
 *      decision tx + post-tx side effects (dispatch / tool-result /
 *      lease+flip) + an opaque `PreparedContinuation` if a mission-run
 *      resume needs to happen in the background.
 *   3. Fires the continuation via `dispatchPreparedMission` (background)
 *      so the IPC handler returns immediately — Codex puzzle-5 phase-3
 *      review point 5: no blocking the renderer on a full resumed loop.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, type Result } from "@shared/ipc/result.js";
import {
  approvalActionInputSchema,
  approvalActionResultSchema,
  type ApprovalActionResult,
} from "@shared/schemas/approvals.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { dispatchPreparedMission } from "../mission/_engine-dispatch.js";
import {
  approvalsDispatchFailedError,
  approvalsUnexpectedError,
} from "./_errors.js";
import {
  mapApproveOutcome,
  mapRejectOutcome,
} from "./_map-outcomes.js";

// ── Approve handler ─────────────────────────────────────────────────────

export function registerApproveHandler(): () => void {
  return registerHandler({
    channel: CH.approvals.approve,
    domain: "approvals",
    inputSchema: approvalActionInputSchema,
    outputSchema: approvalActionResultSchema,
    handle: async (input, ctx): Promise<Result<ApprovalActionResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;

      try {
        const {
          prepareApprove,
          runResumeAfterDecision,
          continuationMissionRunId,
          ApprovalDispatchError,
          ApprovalPostDecisionError,
          ApprovalDecisionInconsistencyError,
        } = await import("@vex-agent/engine/core/approval-runtime.js");

        let outcome: Awaited<ReturnType<typeof prepareApprove>>;
        try {
          outcome = await prepareApprove(input.id);
        } catch (cause) {
          if (cause instanceof ApprovalDispatchError) {
            log.warn(
              `[ipc:vex:approvals:approve] dispatch_failed id=${input.id} ` +
                `errorKind=${cause.errorKind} errorHash=${cause.errorHash} ` +
                `correlationId=${ctx.requestId}`,
            );
            return err(approvalsDispatchFailedError(ctx.requestId));
          }
          if (cause instanceof ApprovalPostDecisionError) {
            log.warn(
              `[ipc:vex:approvals:approve] post_decision_failed id=${input.id} ` +
                `errorKind=${cause.errorKind} errorHash=${cause.errorHash} ` +
                `correlationId=${ctx.requestId}`,
            );
            return err(approvalsDispatchFailedError(ctx.requestId));
          }
          if (cause instanceof ApprovalDecisionInconsistencyError) {
            log.warn(
              `[ipc:vex:approvals:approve] decision_inconsistency id=${input.id} ` +
                `detail=${cause.detail} correlationId=${ctx.requestId}`,
            );
            return err(approvalsUnexpectedError(ctx.requestId));
          }
          throw cause;
        }

        // Dispatch the background continuation when a resume was claimed. This
        // now covers CHAT sessions too (`kind: 'chat_session'`), which is the
        // whole point of the fix — a chat approval used to carry no
        // continuation, so the tool ran and the agent was never re-invoked.
        // Cached/already_*/run_terminated NEVER carry a continuation by design.
        // `policy_drift_blocked` (B-001) is a fail-closed rejection that still
        // resumes so the agent observes the auto-rejection.
        const continuation =
          outcome.kind === "dispatched"
            ? outcome.continuation
            : outcome.kind === "policy_drift_blocked"
              ? outcome.continuation
              : outcome.kind === "expired"
                && outcome.autoRejection.kind === "rejected"
                ? outcome.autoRejection.continuation
                : null;
        if (continuation !== null) {
          const missionRunId = continuationMissionRunId(continuation);
          dispatchPreparedMission(
            () => runResumeAfterDecision(continuation),
            {
              sessionId: continuation.sessionId,
              ...(missionRunId !== undefined ? { missionRunId } : {}),
              correlationId: ctx.requestId,
              channelLabel: "vex:approvals:approve",
              scope: "approval",
            },
          );
        }

        return mapApproveOutcome(outcome, input.id, ctx.requestId);
      } catch (cause) {
        log.warn(
          `[ipc:vex:approvals:approve] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(approvalsUnexpectedError(ctx.requestId));
      }
    },
  });
}

// ── Reject handler ──────────────────────────────────────────────────────

export function registerRejectHandler(): () => void {
  return registerHandler({
    channel: CH.approvals.reject,
    domain: "approvals",
    inputSchema: approvalActionInputSchema,
    outputSchema: approvalActionResultSchema,
    handle: async (input, ctx): Promise<Result<ApprovalActionResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;

      try {
        const {
          prepareReject,
          runResumeAfterDecision,
          continuationMissionRunId,
          ApprovalPostDecisionError,
          ApprovalDecisionInconsistencyError,
        } = await import("@vex-agent/engine/core/approval-runtime.js");

        let outcome: Awaited<ReturnType<typeof prepareReject>>;
        try {
          // The operator's reason finally reaches the engine. It arrived
          // through a `.strict()` Zod gate in preload AND again here, and the
          // engine strips control characters before it becomes model-visible
          // transcript text — it is untrusted input on a path the model reads
          // every turn.
          outcome = await prepareReject(input.id, input.reason);
        } catch (cause) {
          if (cause instanceof ApprovalPostDecisionError) {
            log.warn(
              `[ipc:vex:approvals:reject] post_decision_failed id=${input.id} ` +
                `errorKind=${cause.errorKind} errorHash=${cause.errorHash} ` +
                `correlationId=${ctx.requestId}`,
            );
            return err(approvalsDispatchFailedError(ctx.requestId));
          }
          if (cause instanceof ApprovalDecisionInconsistencyError) {
            log.warn(
              `[ipc:vex:approvals:reject] decision_inconsistency id=${input.id} ` +
                `detail=${cause.detail} correlationId=${ctx.requestId}`,
            );
            return err(approvalsUnexpectedError(ctx.requestId));
          }
          throw cause;
        }

        if (outcome.kind === "rejected" && outcome.continuation !== null) {
          const continuation = outcome.continuation;
          const missionRunId = continuationMissionRunId(continuation);
          dispatchPreparedMission(
            () => runResumeAfterDecision(continuation),
            {
              sessionId: outcome.sessionId,
              ...(missionRunId !== undefined ? { missionRunId } : {}),
              correlationId: ctx.requestId,
              channelLabel: "vex:approvals:reject",
              scope: "approval",
            },
          );
        }

        return mapRejectOutcome(outcome, input.id, ctx.requestId);
      } catch (cause) {
        log.warn(
          `[ipc:vex:approvals:reject] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(approvalsUnexpectedError(ctx.requestId));
      }
    },
  });
}
