/**
 * What an operator Stop does to an approved dispatch — both sides of it.
 *
 * One responsibility, two moments:
 *
 *   - BEFORE the tool leaves the runtime, the step-2b gate already proved the
 *     run is stopped, so nothing runs. `abandonDispatchAfterOperatorStop`
 *     settles the `dispatching` row that was already claimed.
 *   - AFTER it, in the unlocked window where the dispatch, the result commit
 *     and the failure exits live, `applyQueuedOperatorStop` LANDS a Stop that
 *     was queued meanwhile instead of leaving it for a resumed turn that this
 *     very Stop means we must not start.
 *
 * Both live here because they answer the same question — "the user pressed
 * Stop; what is now true of this dispatch?" — and because keeping them apart
 * is how the two halves drift.
 */

import {
  gateOnOperatorStopTransaction,
  type OperatorStopGate,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import type { MissionRunStatus } from "@vex-agent/engine/types.js";
import logger from "@utils/logger.js";

import { discardContinuation } from "../../continuation.js";
import {
  buildDispatchFailedToolResultContent,
  shortSha256,
  summarizeErrorForLog,
} from "../../helpers.js";
import type {
  ApprovePrepareOutcome,
  PreparedContinuation,
} from "../../types.js";
import { commitDispatchFailureToolResult } from "../result-message.js";

/**
 * Structural error kind for an approved dispatch the operator's Stop got in
 * front of. Nothing ran: the gate proved the stop was committed BEFORE this
 * dispatch left the runtime.
 */
export const OPERATOR_STOP_ERROR_KIND = "operator_stop_before_dispatch";

/**
 * Structural error kind for "a Stop may be queued and we could not land it".
 * Not a claim that the user stopped the run — a claim that we cannot prove they
 * did not, which on this path means the agent must not be resumed.
 */
export const STOP_APPLY_FAILED_ERROR_KIND = "operator_stop_apply_failed";

/**
 * The slot was taken but the operator had already stopped this work, so the
 * approved tool is NOT dispatched.
 *
 * Applies to BOTH scopes, deliberately through one function. A session-scoped
 * stop leaves an approved chat tool in exactly the same position as a
 * run-scoped one — claimed, `dispatching`, and forbidden to run — so it gets
 * the same settlement rather than a second shape that could drift from this
 * one. The only difference is that there is no run row to name.
 *
 * The `dispatching` row still has to be settled — the reconciler treats an
 * abandoned `dispatching` row as "the tool MAY have run" and escalates it to
 * `indeterminate`, which would be a false alarm here, and leaving it
 * `not_started` would invite the reconciler to dispatch it after the stop.
 * `commitDispatchFailureToolResult` settles the intent and appends the paired
 * structural tool result in one transaction, so the transcript keeps its
 * tool_call/tool_result balance and the agent can see why nothing executed.
 *
 * The continuation is discarded rather than run: the run row is terminal, so a
 * resume claim could only fail.
 */
export async function abandonDispatchAfterOperatorStop(args: {
  readonly approvalId: string;
  readonly sessionId: string;
  /** `null` for a session-scoped stop — a chat session has no run row. */
  readonly missionRunId: string | null;
  readonly runStatus: MissionRunStatus;
  /** Which stop landed. Log-only; the settlement is identical either way. */
  readonly scope: "run" | "session";
  readonly toolCallId: string;
  readonly continuation: PreparedContinuation | null;
}): Promise<ApprovePrepareOutcome> {
  const errorHash = shortSha256(OPERATOR_STOP_ERROR_KIND);
  logger.warn("engine.approval_runtime.dispatch_skipped_operator_stop", {
    approvalId: args.approvalId,
    sessionId: args.sessionId,
    missionRunId: args.missionRunId,
    runStatus: args.runStatus,
    scope: args.scope,
  });
  // The continuation's release is in a `finally` because ownership of it has
  // ALREADY moved here — the caller nulled its own reference before delegating,
  // so nothing behind us will release it. A throw from the structural-result
  // commit would otherwise strand the lease and leave its heartbeat interval
  // renewing until the TTL, blocking the session for minutes. Nothing is
  // re-dispatched either way: the release is idempotent and the run is terminal.
  try {
    await commitDispatchFailureToolResult({
      approvalId: args.approvalId,
      sessionId: args.sessionId,
      toolCallId: args.toolCallId,
      content: buildDispatchFailedToolResultContent(
        OPERATOR_STOP_ERROR_KIND,
        errorHash,
      ),
      errorHash,
    });
  } finally {
    if (args.continuation !== null) {
      await discardContinuation(args.continuation);
    }
  }
  return {
    kind: "run_terminated",
    approvalId: args.approvalId,
    missionRunId: args.missionRunId,
    runStatus: args.runStatus,
  };
}

/**
 * Land an operator Stop that was queued while this dispatch was running.
 *
 * The pre-dispatch gate only proves nothing was stopped BEFORE the tool left
 * the runtime. Everything after it — the dispatch itself, the result commit, a
 * failed resume preflight — happens unlocked, and a Stop inserted in that
 * window used to be logged and then abandoned: there is no mission
 * `AbortController` on this path, and the only thing that would have applied
 * the request is a resumed turn that a failure exit never reaches. The run then
 * parked in `paused_error` with the user's Stop still sitting in the queue.
 *
 * `gateOnOperatorStopTransaction` both observes and APPLIES, through the one
 * shared stop body, so this reuses the single definition of what a user stop
 * means instead of adding a second one. It is idempotent: a run that is already
 * terminal reports `stopped` without writing anything, so calling it on more
 * than one exit path is free of consequence. Nothing is ever re-dispatched —
 * applying a stop only settles state that already exists.
 *
 * NEVER THROWS. Callers invoke it while a more important failure is already in
 * flight, or with a committed tool result they must still report; a DB blip
 * here must not replace either.
 *
 * A failure is reported as its OWN outcome, `apply_failed`, and never as
 * `clear`. Reporting `clear` would tell the caller "no stop is queued" when the
 * truth is "we could not find out" — so callers decide for themselves, and must
 * not proceed as though the work were free to continue.
 *
 * The reason that matters is that almost nothing else will land the row later.
 * For a MISSION run, the only reader of an open `stop_terminal` is
 * `observeAndApplyControl`, whose only caller is the turn-loop iteration
 * checkpoint (`turn-loop-observe.ts`); a run being parked in `paused_error`
 * reaches no further boundary, so the row sits `pending` until a user-initiated
 * resume of the SAME run, and never at all if the user never resumes.
 *
 * For a SESSION-scoped stop the readers are different but the conclusion is the
 * same: the continuation scheduler's gate and the wake-driven slice's pre-slice
 * gate both consume one, but a session whose slice just ended may never run
 * either again. (This paragraph replaces an older claim that a chat session had
 * no stop row to read at all — true before session-scoped stops existed, false
 * now, and the stale premise is what left this function skipping them.)
 *
 * BOTH SCOPES ARE HANDLED. This used to early-return `clear` whenever
 * `missionRunId` was null — the same false premise the pre-dispatch gate
 * carried, in the narrower post-dispatch window. The consequence was a session
 * stop queued WHILE an approved chat tool was executing never being landed: the
 * request stayed `pending` and the continuation was handed back, resuming the
 * agent on a session the operator had stopped. The executed tool is still never
 * undone — that is the in-flight rule, not a scope question.
 */
export type QueuedOperatorStopOutcome =
  | OperatorStopGate
  | { readonly kind: "apply_failed"; readonly errorKind: string };

export async function applyQueuedOperatorStop(args: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly missionRunId: string | null;
}): Promise<QueuedOperatorStopOutcome> {
  try {
    // No scope test: the gate itself decides what a stop means for this
    // session, and it consumes a session-scoped one exactly as it consumes a
    // run-scoped one. Skipping the call for a null run was the gap.
    const gate = await gateOnOperatorStopTransaction({
      sessionId: args.sessionId,
      missionRunId: args.missionRunId,
    });
    if (gate.kind === "stopped") {
      logger.warn("engine.approval_runtime.stop_applied_after_dispatch", {
        approvalId: args.approvalId,
        sessionId: args.sessionId,
        missionRunId: args.missionRunId,
        runStatus: gate.runStatus,
        scope: gate.scope,
      });
    }
    return gate;
  } catch (cause) {
    const errorKind = summarizeErrorForLog(cause).errorKind;
    logger.warn("engine.approval_runtime.stop_apply_failed", {
      approvalId: args.approvalId,
      sessionId: args.sessionId,
      missionRunId: args.missionRunId,
      errorKind,
    });
    return { kind: "apply_failed", errorKind };
  }
}
