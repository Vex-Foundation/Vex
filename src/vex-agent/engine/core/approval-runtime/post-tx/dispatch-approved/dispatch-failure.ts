/**
 * The approved tool's dispatch threw — make that DURABLE and nothing else.
 *
 * One reason to change: recording an unhandled dispatch failure so no caller
 * can lose it. The stop-then-park ordering that follows, and the release of the
 * continuation, belong to `applyApproveSideEffects`' catch funnel — keeping
 * them out of here is what leaves exactly one place where the ordering
 * "result → stop → paused_error" is expressed.
 *
 * Transcript content is structural-only (errorKind + errorHash). Raw or
 * redacted error text is intentionally absent: tool/protocol/wallet errors can
 * carry secrets the agent must not see.
 */

import logger from "@utils/logger.js";

import { scheduleDeferredResumeRetries } from "../../deferred-resume.js";
import {
  buildDispatchFailedToolResultContent,
  summarizeErrorForLog,
} from "../../helpers.js";
import { ApprovalDispatchError } from "../../types.js";
import { commitDispatchFailureToolResult } from "../result-message.js";

export async function onDispatchThrow(
  approvalId: string,
  sessionId: string,
  missionRunId: string | null,
  toolCallId: string,
  cause: unknown,
): Promise<never> {
  const errSummary = summarizeErrorForLog(cause);
  // Structural log only — never the raw message or cause.
  logger.warn("engine.approval_runtime.dispatch_threw", {
    approvalId,
    sessionId,
    missionRunId,
    errorKind: errSummary.errorKind,
    errorHash: errSummary.errorHash,
  });

  // Status + structural transcript row + result id, atomically. Committing the
  // result id here is what lets a CHAT session still be woken to observe the
  // failure: the durable resume paths key off an unconsumed result, and this
  // error is reported to the IPC as a throw, which carries no continuation.
  await commitDispatchFailureToolResult({
    approvalId,
    sessionId,
    toolCallId,
    content: buildDispatchFailedToolResultContent(
      errSummary.errorKind,
      errSummary.errorHash,
    ),
    errorHash: errSummary.errorHash,
  });

  if (missionRunId === null) {
    // Chat session: there is no `paused_error` to park in, so the agent must
    // still be woken to see the structural failure. Fast in-process attempt;
    // the reconciler is the durable backstop if it does not land.
    scheduleDeferredResumeRetries(sessionId);
  }

  throw new ApprovalDispatchError(
    approvalId,
    errSummary.errorKind,
    errSummary.errorHash,
  );
}
