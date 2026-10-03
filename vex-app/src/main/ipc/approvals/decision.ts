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
 *
 * With `APPROVAL_DISPATCH_BACKGROUND` on (K-2 B2, default off), a desk
 * approve answers at its committed dispatch-slot claim and its outcome follows
 * as an event; see `approveWithBackgroundDispatch`.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
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
import {
  approvalDispatchBackgroundEnabled,
  emitApprovalDispatchEvent,
} from "./_dispatch-background.js";

// ── Approve handler ─────────────────────────────────────────────────────

type ApprovalRuntimeModule = typeof import("@vex-agent/engine/core/approval-runtime.js");
type ApproveOutcome = Awaited<ReturnType<ApprovalRuntimeModule["prepareApprove"]>>;

/**
 * A `prepareApprove` throw, mapped to the reply. An unrecognised throw is
 * re-thrown for the caller's catch-all, exactly as before.
 */
function mapApproveThrow(
  runtime: ApprovalRuntimeModule,
  cause: unknown,
  id: string,
  requestId: string,
): Result<ApprovalActionResult> {
  if (cause instanceof runtime.ApprovalDispatchError) {
    log.warn(
      `[ipc:vex:approvals:approve] dispatch_failed id=${id} ` +
        `errorKind=${cause.errorKind} errorHash=${cause.errorHash} ` +
        `correlationId=${requestId}`,
    );
    return err(approvalsDispatchFailedError(requestId));
  }
  if (cause instanceof runtime.ApprovalPostDecisionError) {
    log.warn(
      `[ipc:vex:approvals:approve] post_decision_failed id=${id} ` +
        `errorKind=${cause.errorKind} errorHash=${cause.errorHash} ` +
        `correlationId=${requestId}`,
    );
    return err(approvalsDispatchFailedError(requestId));
  }
  if (cause instanceof runtime.ApprovalDecisionInconsistencyError) {
    log.warn(
      `[ipc:vex:approvals:approve] decision_inconsistency id=${id} ` +
        `detail=${cause.detail} correlationId=${requestId}`,
    );
    return err(approvalsUnexpectedError(requestId));
  }
  throw cause;
}

/** A settled `prepareApprove` outcome: fire its continuation, map the reply. */
function finishApprove(
  runtime: ApprovalRuntimeModule,
  outcome: ApproveOutcome,
  id: string,
  requestId: string,
): Result<ApprovalActionResult> {
  // Dispatch the background continuation when a resume was claimed. This
  // now covers CHAT sessions too (`kind: 'chat_session'`), which is the
  // whole point of the fix: a chat approval used to carry no
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
    const missionRunId = runtime.continuationMissionRunId(continuation);
    dispatchPreparedMission(
      () => runtime.runResumeAfterDecision(continuation),
      {
        sessionId: continuation.sessionId,
        ...(missionRunId !== undefined ? { missionRunId } : {}),
        correlationId: requestId,
        channelLabel: "vex:approvals:approve",
        scope: "approval",
      },
    );
  }

  return mapApproveOutcome(outcome, id, requestId);
}

function logApproveFailure(requestId: string, cause: unknown): void {
  log.warn(
    `[ipc:vex:approvals:approve] failed correlationId=${requestId}`,
    cause,
  );
}

/**
 * `APPROVAL_DISPATCH_BACKGROUND` on (K-2 B2). The SAME `prepareApprove` call
 * runs to its end under the same owner; this only changes when the click is
 * answered. A desk dispatch announces its committed slot claim, and the reply
 * goes back then with `executionStatus: "dispatching"`; the outcome the
 * awaited reply would have carried follows on `EV.approvals.dispatch`, mapped
 * by the very functions the awaited path uses. Every other lane never
 * announces, so it is awaited and answered exactly as with the switch off.
 *
 * Nothing here can stop or repeat the dispatch: the reply does not cancel the
 * engine promise, and a quit mid-flight ends it the way it always ended an
 * awaited one, leaving a `dispatching` row for the desk reconciler.
 */
async function approveWithBackgroundDispatch(
  runtime: ApprovalRuntimeModule,
  id: string,
  requestId: string,
): Promise<Result<ApprovalActionResult>> {
  let announce: (started: { readonly resolvedAt: string }) => void = () => undefined;
  const started = new Promise<{ readonly resolvedAt: string }>((resolve) => {
    announce = resolve;
  });
  const flight = runtime
    .prepareApprove(id, { onDispatchStarted: (event) => announce(event) })
    .then(
      (outcome) => ({ kind: "outcome", outcome }) as const,
      (cause: unknown) => ({ kind: "threw", cause }) as const,
    );
  const first = await Promise.race([
    flight,
    started.then((event) => ({ kind: "started", event }) as const),
  ]);
  if (first.kind === "outcome") return finishApprove(runtime, first.outcome, id, requestId);
  if (first.kind === "threw") return mapApproveThrow(runtime, first.cause, id, requestId);

  log.info(
    `[ipc:vex:approvals:approve] dispatching id=${id} background=1 ` +
      `correlationId=${requestId}`,
  );
  emitApprovalDispatchEvent({ phase: "dispatching", approvalId: id });
  void flight.then((settled) => {
    let result: Result<ApprovalActionResult>;
    try {
      result = settled.kind === "outcome"
        ? finishApprove(runtime, settled.outcome, id, requestId)
        : mapApproveThrow(runtime, settled.cause, id, requestId);
    } catch (cause) {
      logApproveFailure(requestId, cause);
      result = err(approvalsUnexpectedError(requestId));
    }
    emitApprovalDispatchEvent(result.ok
      ? { phase: "settled", approvalId: id, result: result.data }
      : { phase: "failed", approvalId: id, error: result.error });
  });
  return ok({
    id,
    status: "approved",
    resolvedAt: first.event.resolvedAt,
    // A desk row never carries a continuation, so this is what the settled
    // outcome will say too.
    runtimeOutcome: "stopped",
    executionStatus: "dispatching",
    missionRunId: null,
    cached: false,
    message: "Approved. Sending now; the outcome follows.",
  });
}

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
        const runtime = await import("@vex-agent/engine/core/approval-runtime.js");

        if (approvalDispatchBackgroundEnabled()) {
          return await approveWithBackgroundDispatch(runtime, input.id, ctx.requestId);
        }

        // Switch off: today's awaited approve. No dispatch-started listener
        // is passed, so the engine call is the one it always was.
        let outcome: ApproveOutcome;
        try {
          outcome = await runtime.prepareApprove(input.id);
        } catch (cause) {
          return mapApproveThrow(runtime, cause, input.id, ctx.requestId);
        }

        return finishApprove(runtime, outcome, input.id, ctx.requestId);
      } catch (cause) {
        logApproveFailure(ctx.requestId, cause);
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
