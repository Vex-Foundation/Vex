/**
 * Approval runtime — locked-tx snapshot phase: discriminated-union types.
 *
 * The snapshot row + the private discriminated-union outcomes returned by the
 * snapshot builders. The public entry points in `../../approval-runtime.ts`
 * map these to the IPC contract.
 */

import type {
  ApprovalDecision,
  ApprovalOrigin,
  ApprovalRefusalReason,
} from "../../../../db/repos/approval-intents.js";
import * as approvalIntentsRepo from "../../../../db/repos/approval-intents.js";
import type { MissionRunStatus, Permission } from "../../../types.js";

/**
 * Denormalised intent+queue row used inside the snapshot tx. Carrying
 * queue columns alongside intent columns avoids a second query when the
 * post-tx side effects need tool-call data.
 */
export interface IntentSnapshotRow {
  // intent columns
  approval_id: string;
  session_id: string;
  mission_run_id: string | null;
  tool_call_id: string | null;
  expires_at: Date | string | null;
  decision: ApprovalDecision | null;
  decision_reason: string | null;
  decided_at: Date | string | null;
  execution_status: approvalIntentsRepo.ApprovalExecutionStatus | null;
  execution_result_hash: string | null;
  // Studio columns (migration 086). `origin` is NOT NULL with a default, so it
  // is always present; the rest are NULL for every agent row.
  origin: ApprovalOrigin;
  project_id: string | null;
  scope_version_at_enqueue: number | string | null;
  request_digest: string | null;
  // queue columns (denormalised join)
  queue_status: string;
  queue_resolved_at: Date | string | null;
  queue_created_at: Date | string;
  queue_tool_call: Record<string, unknown>;
  queue_tool_call_id: string | null;
  queue_permission_at_enqueue: Permission;
  // LIVE session permission (B-001 — approve-time re-enforcement). Read from
  // `sessions.permission` in the same snapshot SELECT, which locks the joined
  // `sessions s` row (`FOR UPDATE OF i, q, s`) so the approve gate compares the
  // captured enqueue snapshot against a live policy value that a concurrent
  // permission-downgrade tx cannot change until this approve commits.
  session_permission_live: Permission;
}

/**
 * The authority that moved between enqueue and approve. See
 * `ApproveSnapshot["policy_drift_blocked"].driftKind`.
 */
export type ApprovalDriftKind =
  | "session_permission"
  | "project_permission"
  | "project_deleted"
  | "scope_changed";

export type ApproveSnapshot =
  | { type: "not_found" }
  | { type: "cached_approved"; row: IntentSnapshotRow }
  | { type: "already_rejected"; row: IntentSnapshotRow }
  | {
      type: "run_terminated";
      row: IntentSnapshotRow;
      runStatus: MissionRunStatus;
    }
  | {
      type: "expired_in_tx";
      row: IntentSnapshotRow;
      expiredAt: string;
      queueResolvedAt: string;
    }
  | {
      // B-001 — live permission drifted MORE restrictive than the snapshot
      // captured at enqueue. Queue+intent were flipped to `rejected` in-tx
      // (NOT approved, NOT pending); the approve fails closed before any
      // dispatch state transition.
      type: "policy_drift_blocked";
      row: IntentSnapshotRow;
      queueResolvedAt: string;
      reason: string;
      permissionAtEnqueue: Permission;
      livePermission: Permission;
      /**
       * WHICH authority moved. `session_permission` is the original B-001 case
       * and the only one an agent row can reach, so an agent approve is
       * unchanged in value as well as in shape. The three Studio cases share
       * this outcome because they are the same event: authority the human
       * approved under no longer holds, so the action failed CLOSED before any
       * dispatch state transition.
       */
      driftKind: ApprovalDriftKind;
      /**
       * The machine cause written to `refusal_reason`, for the two Studio
       * cases that have one. `null` for both permission drifts, which are
       * policy drift rather than a refusal by an owner.
       */
      refusalReason: ApprovalRefusalReason | null;
    }
  | {
      type: "approved_in_tx";
      row: IntentSnapshotRow;
      queueResolvedAt: string;
    };

export type RejectSnapshot =
  | { type: "not_found" }
  | { type: "cached_rejected"; row: IntentSnapshotRow }
  | { type: "already_approved"; row: IntentSnapshotRow }
  | {
      type: "rejected_in_tx";
      row: IntentSnapshotRow;
      queueResolvedAt: string;
      reason: string;
    };
