/**
 * Approval runtime — public types + named error classes.
 *
 * Discriminated unions are the IPC-mapping contract (Codex puzzle-5 phase-3
 * review point 6 — no `TurnResult` synthesis as decision shape). Phase 3
 * adds `executionStatus`, `missionRunId`, `cached`, and `expiresAt` data so
 * the renderer can render the decision lifecycle without a second IPC call.
 */

import type { ApprovalExecutionStatus } from "../../../db/repos/approval-intents.js";
import type { LeaseHandle } from "../../runtime/lease-handle.js";
import type { MissionRunStatus } from "../../types.js";

interface PreparedContinuationBase {
  readonly sessionId: string;
  readonly leaseHandle: LeaseHandle;
  readonly ownerId: string;
  /**
   * The approval this continuation exists to deliver.
   * `runResumeAfterDecision` marks it consumed under the held lease once the
   * resumed turn has durably COMPLETED. That completion marker — not the
   * attempt, and not the moment the turn started — is what stops a later pass
   * from firing the resume twice, while a crash before it leaves the approval
   * recoverable.
   */
  readonly approvalId: string;
}

/**
 * Opaque resumed-agent continuation. Owned by the bounded prepare path;
 * consumed by `runResumeAfterDecision()` (sole release responsibility) OR
 * defensively by `discardContinuation()` if the caller cannot schedule.
 *
 * Two shapes, because a resolved approval has to restart two different kinds
 * of work. A mission run resumes its loop (`paused_approval → running` lease
 * flip); an Agent-Restricted chat session has no run to flip, so it re-enters
 * a single agent turn under a plain session lease. Before this union existed,
 * only the mission arm was implemented and every chat approval silently ended
 * the conversation — the tool executed and the agent was never told.
 *
 * The lease handle is engine-internal — main treats this struct as opaque
 * even though it carries strict types. Holding a continuation without
 * scheduling it (or discarding it) leaks a lease until the TTL expires.
 */
export type PreparedContinuation =
  | (PreparedContinuationBase & {
      readonly kind: "mission_run";
      readonly missionRunId: string;
    })
  | (PreparedContinuationBase & {
      readonly kind: "chat_session";
    });

/**
 * Narrow a continuation to the mission-run id the desktop host uses for its
 * dispatch log refs. `undefined` for a chat session — there is no run.
 */
export function continuationMissionRunId(
  cont: PreparedContinuation,
): string | undefined {
  return cont.kind === "mission_run" ? cont.missionRunId : undefined;
}

export type ApprovePrepareOutcome =
  | {
      readonly kind: "dispatched";
      readonly approvalId: string;
      readonly resolvedAt: string;
      readonly executionStatus: "succeeded" | "failed";
      readonly sessionId: string;
      readonly missionRunId: string | null;
      readonly continuation: PreparedContinuation | null;
      readonly toolResult: { success: boolean; output: string };
    }
  | {
      readonly kind: "cached_approved";
      readonly approvalId: string;
      readonly resolvedAt: string;
      readonly executionStatus: ApprovalExecutionStatus;
      readonly missionRunId: string | null;
    }
  | {
      readonly kind: "expired";
      readonly approvalId: string;
      readonly expiresAt: string;
      readonly autoRejection: RejectPrepareOutcome;
    }
  | {
      /**
       * B-001 — the live session permission drifted strictly MORE restrictive
       * than the permission captured at enqueue, so the approved action is no
       * longer permitted to dispatch. The approve FAILED CLOSED: queue+intent
       * are `rejected` (NOT approved, NOT pending), NO tool was dispatched, and
       * the appended tool-result is a rejection (not an approved result). The
       * mission run resumes via `continuation` to observe the rejection. IPC
       * maps this to `approvals.policy_drift_blocked`.
       */
      readonly kind: "policy_drift_blocked";
      readonly approvalId: string;
      readonly resolvedAt: string;
      readonly sessionId: string;
      readonly missionRunId: string | null;
      readonly permissionAtEnqueue: "restricted" | "full";
      readonly livePermission: "restricted" | "full";
      readonly continuation: PreparedContinuation | null;
    }
  | {
      /**
       * The decision committed but the continuation could not be claimed —
       * another runner holds the session lease. Because the claim now happens
       * BEFORE dispatch, this means the approved tool has NOT run: the intent
       * stays `approved` / `not_started` and becomes a durable deferred resume
       * that the backoff retries, the end-of-turn hook, or the reconciler will
       * pick up. Reporting it as a dispatch failure (the old behaviour) told
       * the user the opposite of the truth.
       */
      readonly kind: "deferred_busy";
      readonly approvalId: string;
      readonly resolvedAt: string;
      readonly sessionId: string;
      readonly missionRunId: string | null;
      /** `true` once a tool result exists and only the resume is outstanding. */
      readonly resultCommitted: boolean;
    }
  | {
      readonly kind: "already_rejected";
      readonly approvalId: string;
      readonly resolvedAt: string;
      readonly decision: "rejected" | "rejected_stop";
    }
  | {
      readonly kind: "run_terminated";
      readonly approvalId: string;
      /**
       * `null` when the STOP was session-scoped — a chat session has no run
       * row. `runStatus` then carries the `cancelled` terminal by convention
       * (see `gateOnOperatorStopWithClient`), not a real `mission_runs` status.
       */
      readonly missionRunId: string | null;
      readonly runStatus: MissionRunStatus;
    };

export type RejectPrepareOutcome =
  | {
      readonly kind: "rejected";
      readonly approvalId: string;
      readonly resolvedAt: string;
      readonly sessionId: string;
      readonly missionRunId: string | null;
      readonly reason: string;
      readonly continuation: PreparedContinuation | null;
    }
  | {
      readonly kind: "cached_rejected";
      readonly approvalId: string;
      readonly resolvedAt: string;
      readonly decision: "rejected" | "rejected_stop";
      readonly reason: string | null;
      readonly missionRunId: string | null;
    }
  | {
      /**
       * Rejection committed and its tool result is in the transcript, but the
       * resume could not be claimed right now. The result is durable and
       * unconsumed, so the agent still gets woken — just not on this call.
       */
      readonly kind: "deferred_busy";
      readonly approvalId: string;
      readonly resolvedAt: string;
      readonly sessionId: string;
      readonly missionRunId: string | null;
      readonly reason: string;
    }
  | {
      readonly kind: "already_approved";
      readonly approvalId: string;
      readonly resolvedAt: string;
      readonly missionRunId: string | null;
    };

export interface SweepResult {
  readonly swept: number;
  readonly errored: number;
  readonly continuations: ReadonlyArray<PreparedContinuation>;
}

/**
 * Tool dispatch handler threw an unhandled exception after the approval
 * decision tx committed. The mission run has been flipped to `paused_error`;
 * no continuation was scheduled. IPC maps to `approvals.dispatch_failed`.
 */
export class ApprovalDispatchError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly errorKind: string,
    public readonly errorHash: string,
  ) {
    super(
      `Tool dispatch failed after approval (${approvalId}): ${errorKind} [hash ${errorHash}]`,
    );
    this.name = "ApprovalDispatchError";
  }
}

/**
 * A dispatcher tried to settle an approval it no longer owned: the intent had
 * already left `dispatching` (reconciled to `indeterminate`, or settled by
 * another writer) by the time the result commit ran.
 *
 * Thrown from INSIDE the result transaction so the transcript row rolls back
 * with it. That is the point: a late dispatcher must not overwrite a terminal
 * `indeterminate` verdict with an outcome it can no longer prove, and must not
 * append a second tool result for a tool call that already has one.
 */
export class ApprovalResultSupersededError extends Error {
  constructor(public readonly approvalId: string) {
    super(
      `Approval ${approvalId} result commit superseded — the intent left ` +
        "`dispatching` before this dispatcher could settle it",
    );
    this.name = "ApprovalResultSupersededError";
  }
}

/**
 * Internal invariant violation — queue.status and intent.decision drifted
 * apart (queue.status='pending' but intent.decision != null, or vice versa).
 * Should never happen in normal flow because every decision tx commits both
 * sides together. IPC maps to `internal.unexpected`.
 */
export class ApprovalDecisionInconsistencyError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly detail: string,
  ) {
    super(
      `Approval ${approvalId} decision/queue state inconsistency: ${detail}`,
    );
    this.name = "ApprovalDecisionInconsistencyError";
  }
}

/**
 * Post-decision side effect (markExecutionStatus / appendMessage / lease
 * claim) failed AFTER the queue+intent decision tx committed. The mission
 * run has been explicitly transitioned to `paused_error` so the operator
 * can `/retry` to recover. IPC maps to `approvals.dispatch_failed`.
 *
 * Distinct from `ApprovalDispatchError` (which fires when the tool handler
 * itself throws) so the audit/log path keeps the cause categories separate.
 */
export class ApprovalPostDecisionError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly errorKind: string,
    public readonly errorHash: string,
  ) {
    super(
      `Approval ${approvalId} post-decision side effect failed: ${errorKind} [hash ${errorHash}]`,
    );
    this.name = "ApprovalPostDecisionError";
  }
}
