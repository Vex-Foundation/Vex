/**
 * Approvals IPC — discriminated-outcome → `Result<ApprovalActionResult>`
 * mappers. Phase 3 isolates the mapping logic so the main handler module
 * stays focused on the handler shell + background dispatch glue.
 *
 * `runtimeOutcome` is independent of `executionStatus`: if a continuation was
 * claimed the agent resumes (`runtimeOutcome: 'resumed'`) even when the tool
 * dispatch reported a controlled failure (`executionStatus: 'failed'`).
 *
 * EVERY message here is derived from what actually happened. This module used
 * to tell the user "agent will continue" on every successful dispatch,
 * including chat sessions where no continuation existed and the agent was
 * therefore never resumed at all — the message asserted the exact behaviour
 * that was broken. Messages now follow the claimed continuation:
 * resumed / deferred / stopped.
 */

import { ok, err, type Result } from "@shared/ipc/result.js";
import type { ApprovalActionResult } from "@shared/schemas/approvals.js";
import { log } from "../../logger/index.js";
import {
  approvalsAlreadyResolvedError,
  approvalsExpiredError,
  approvalsPolicyDriftBlockedError,
  approvalsRunTerminatedError,
} from "./_errors.js";

// Typed via the engine's exported outcome unions. The dynamic-import return
// shape is awaited here so the mapper compiles even though approval-runtime
// is loaded lazily inside the IPC handler.
type ApprovePrepareOutcome = Awaited<
  ReturnType<
    typeof import("@vex-agent/engine/core/approval-runtime.js")["prepareApprove"]
  >
>;
type RejectPrepareOutcome = Awaited<
  ReturnType<
    typeof import("@vex-agent/engine/core/approval-runtime.js")["prepareReject"]
  >
>;

export function mapApproveOutcome(
  outcome: ApprovePrepareOutcome,
  id: string,
  correlationId: string,
): Result<ApprovalActionResult> {
  switch (outcome.kind) {
    case "dispatched": {
      const resumed = outcome.continuation !== null;
      const toolPart =
        outcome.executionStatus === "succeeded"
          ? "Tool executed"
          : "Tool failed; see transcript";
      // Only promise a continuation when one was actually claimed.
      const message = resumed
        ? `Approved. ${toolPart}; agent is continuing.`
        : `Approved. ${toolPart}.`;
      log.info(
        `[ipc:vex:approvals:approve] ok id=${id} ` +
          `executionStatus=${outcome.executionStatus} ` +
          `resumed=${resumed} ` +
          `missionRunId=${outcome.missionRunId ?? "<none>"} ` +
          `correlationId=${correlationId}`,
      );
      return ok({
        id,
        status: "approved",
        resolvedAt: outcome.resolvedAt,
        runtimeOutcome: resumed ? "resumed" : "stopped",
        executionStatus: outcome.executionStatus,
        missionRunId: outcome.missionRunId,
        cached: false,
        message,
      });
    }
    case "deferred_busy":
      // The decision committed but the tool was deliberately NOT dispatched —
      // another runner holds the session lease. Saying anything about a tool
      // result here would be a lie; the honest answer is "queued".
      log.info(
        `[ipc:vex:approvals:approve] deferred_busy id=${id} ` +
          `missionRunId=${outcome.missionRunId ?? "<none>"} ` +
          `correlationId=${correlationId}`,
      );
      return ok({
        id,
        status: "approved",
        resolvedAt: outcome.resolvedAt,
        runtimeOutcome: "deferred_busy",
        executionStatus: "not_started",
        missionRunId: outcome.missionRunId,
        cached: false,
        message:
          "Approved. The session is busy, so the action is queued and will "
          + "run as soon as the current turn finishes.",
      });
    case "cached_approved":
      log.info(
        `[ipc:vex:approvals:approve] cached id=${id} ` +
          `executionStatus=${outcome.executionStatus} ` +
          `correlationId=${correlationId}`,
      );
      return ok({
        id,
        status: "approved",
        resolvedAt: outcome.resolvedAt,
        runtimeOutcome: "stopped",
        executionStatus: outcome.executionStatus,
        missionRunId: outcome.missionRunId,
        cached: true,
        message: "Approval already resolved.",
      });
    case "expired":
      return err(approvalsExpiredError(correlationId, outcome.expiresAt));
    case "policy_drift_blocked":
      // B-001 — fail closed: the approved action was rejected before dispatch
      // because the live permission drifted more restrictive. Surface a
      // non-actionable error (renderer toasts "cannot proceed").
      log.warn(
        `[ipc:vex:approvals:approve] policy_drift_blocked id=${id} ` +
          `permissionAtEnqueue=${outcome.permissionAtEnqueue} ` +
          `livePermission=${outcome.livePermission} ` +
          `missionRunId=${outcome.missionRunId ?? "<none>"} ` +
          `correlationId=${correlationId}`,
      );
      return err(approvalsPolicyDriftBlockedError(correlationId));
    case "already_rejected":
      return err(
        approvalsAlreadyResolvedError(correlationId, outcome.decision),
      );
    case "run_terminated":
      return err(
        approvalsRunTerminatedError(correlationId, outcome.runStatus),
      );
  }
}

export function mapRejectOutcome(
  outcome: RejectPrepareOutcome,
  id: string,
  correlationId: string,
): Result<ApprovalActionResult> {
  switch (outcome.kind) {
    case "rejected": {
      const resumed = outcome.continuation !== null;
      log.info(
        `[ipc:vex:approvals:reject] ok id=${id} ` +
          `resumed=${resumed} ` +
          `missionRunId=${outcome.missionRunId ?? "<none>"} ` +
          `correlationId=${correlationId}`,
      );
      return ok({
        id,
        status: "rejected",
        resolvedAt: outcome.resolvedAt,
        runtimeOutcome: resumed ? "resumed" : "stopped",
        executionStatus: null,
        missionRunId: outcome.missionRunId,
        cached: false,
        message: resumed
          ? "Rejected. The agent is continuing with the rejection in context."
          : "Rejected. The rejection is recorded in the transcript.",
      });
    }
    case "deferred_busy":
      // The rejection IS recorded; only the agent wake is queued.
      log.info(
        `[ipc:vex:approvals:reject] deferred_busy id=${id} ` +
          `missionRunId=${outcome.missionRunId ?? "<none>"} ` +
          `correlationId=${correlationId}`,
      );
      return ok({
        id,
        status: "rejected",
        resolvedAt: outcome.resolvedAt,
        runtimeOutcome: "deferred_busy",
        executionStatus: null,
        missionRunId: outcome.missionRunId,
        cached: false,
        message:
          "Rejected. The session is busy, so the agent will pick the "
          + "rejection up as soon as the current turn finishes.",
      });
    case "cached_rejected":
      log.info(
        `[ipc:vex:approvals:reject] cached id=${id} ` +
          `decision=${outcome.decision} correlationId=${correlationId}`,
      );
      return ok({
        id,
        status: "rejected",
        resolvedAt: outcome.resolvedAt,
        runtimeOutcome: "stopped",
        executionStatus: null,
        missionRunId: outcome.missionRunId,
        cached: true,
        message: "Approval already rejected.",
      });
    case "already_approved":
      return err(approvalsAlreadyResolvedError(correlationId, "approved"));
  }
}
