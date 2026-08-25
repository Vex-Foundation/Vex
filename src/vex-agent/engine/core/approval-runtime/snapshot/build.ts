/**
 * Approval runtime — locked-tx snapshot phase: ordering owners.
 *
 * The tx locks the `approval_intents`, `approval_queue`, AND `sessions` rows
 * (`FOR UPDATE OF i, q, s`) and decides which path the post-tx side-effects
 * will run. Locking `sessions s` serializes the LIVE permission read
 * (`s.permission`) against a concurrent permission-downgrade tx, so the
 * approve-time re-enforcement (B-001) compares the enqueue snapshot against a
 * permission value that cannot change underneath this approve until it commits.
 * The TTL gate uses DB-side `NOW()` so an approve that races the TTL boundary
 * observes a single committed truth.
 *
 * Codex puzzle-5 phase-3 review point 4 — atomic TTL gate inside the same
 * locked tx as the queue CAS.
 *
 * Returns a private discriminated-union snapshot; the public entry points
 * in `../../approval-runtime.ts` map this to the IPC contract. This module is
 * the ORDERING OWNER — every queue/intent CAS write happens here, in order.
 */

import type { ClientBase } from "pg";

import * as approvalsRepo from "../../../../db/repos/approvals.js";
import * as approvalIntentsRepo from "../../../../db/repos/approval-intents.js";
import * as missionRunsRepo from "../../../../db/repos/mission-runs.js";
import { TERMINAL_RUN_STATUSES, type Permission } from "../../../types.js";
import { ApprovalDecisionInconsistencyError } from "../types.js";
import {
  isPermissionMoreRestrictive,
  TOOL_RESULT_EXPIRED_REASON,
  TOOL_RESULT_POLICY_DRIFT_REASON,
  toIso,
  toIsoNow,
} from "../helpers.js";
import { getDbNow, lockAndLoadSnapshot } from "./compare.js";
import type {
  ApprovalDriftKind,
  ApproveSnapshot,
  IntentSnapshotRow,
  RejectSnapshot,
} from "./types.js";
import type { ApprovalRefusalReason } from "../../../../db/repos/approval-intents.js";

export async function buildApproveSnapshot(
  client: ClientBase,
  approvalId: string,
): Promise<ApproveSnapshot> {
  const row = await lockAndLoadSnapshot(client, approvalId);
  if (row === null) return { type: "not_found" };

  // Cached decision — return early. Drift sanity-check: queue.status='pending'
  // alongside a non-null intent.decision is an inconsistency by construction.
  if (row.decision !== null) {
    if (row.queue_status === "pending") {
      throw new ApprovalDecisionInconsistencyError(
        approvalId,
        `decision=${row.decision} but queue.status=pending`,
      );
    }
    if (row.decision === "approved") return { type: "cached_approved", row };
    return { type: "already_rejected", row };
  }

  if (row.queue_status !== "pending") {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      `queue.status=${row.queue_status} but decision=null`,
    );
  }

  // Atomic TTL check using DB-side NOW(). The intent row is locked, so a
  // concurrent expire/sweep is blocked until our tx commits — no race.
  if (row.expires_at !== null) {
    const expiresAt = row.expires_at instanceof Date
      ? row.expires_at
      : new Date(row.expires_at);
    const dbNow = await getDbNow(client);
    if (expiresAt <= dbNow) {
      return autoRejectInTx(client, row, approvalId, expiresAt);
    }
  }

  // Defensive: mission run terminal AFTER this approval was created
  // (operator-driven `abortMissionRun` raced between enqueue and approve).
  if (row.mission_run_id !== null) {
    const recentRun = await missionRunsRepo.getRunBySession(
      row.session_id,
      client,
    );
    const queueCreatedAt =
      row.queue_created_at instanceof Date
        ? row.queue_created_at.toISOString()
        : row.queue_created_at;
    if (
      recentRun !== null
      && TERMINAL_RUN_STATUSES.has(recentRun.status)
      && recentRun.endedAt !== null
      && recentRun.endedAt > queueCreatedAt
    ) {
      return { type: "run_terminated", row, runStatus: recentRun.status };
    }
  }

  // B-001 — re-enforce the live permission policy at approve time. The
  // permission captured at enqueue (`queue_permission_at_enqueue`) is a
  // snapshot; if the LIVE `sessions.permission` (read above under the same
  // lock) drifted strictly MORE restrictive, an action authorized under the
  // looser policy must NOT dispatch. Fail closed BEFORE the approve CAS:
  // flip queue+intent to `rejected` in-tx so the post-tx side effects take
  // the reject path (no approved decision, no dispatch, no approved
  // tool-result). Unchanged or looser live permission falls through to the
  // byte-identical happy path below.
  if (
    isPermissionMoreRestrictive(
      row.session_permission_live,
      row.queue_permission_at_enqueue,
    )
  ) {
    return policyDriftRejectInTx(client, row, approvalId, {
      driftKind: "session_permission",
      refusalReason: null,
      livePermission: row.session_permission_live,
    });
  }

  // A2/A3 - the Vex Studio commit-time check. A Studio approval is authorized
  // by a PROJECT, not by the agent session's own columns, so the session
  // mirror above is necessary and not sufficient: the project could have been
  // deleted, its scope edited, or its permission tightened while the card sat
  // on screen. The project row is locked LAST (`FOR UPDATE`), after the
  // session control lock this transaction already holds and after the
  // approval rows locked above, which is the documented global lock order and
  // the same order `updateProjectScope` takes.
  if (row.origin === "studio_mcp") {
    const drift = await readProjectDrift(client, row);
    if (drift !== null) {
      return policyDriftRejectInTx(client, row, approvalId, drift);
    }
  }

  // Happy path — CAS queue.approve + CAS intent.decision='approved' in tx.
  const queueRow = await approvalsRepo.approveWith(client, approvalId);
  if (queueRow === null) {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      "approve queue CAS missed despite FOR UPDATE",
    );
  }
  const ok = await approvalIntentsRepo.markDecisionWith(client, {
    approvalId,
    kind: "approved",
    idempotencyKey: approvalId,
  });
  if (!ok) {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      "approve intent CAS missed despite decision=null",
    );
  }
  return {
    type: "approved_in_tx",
    row,
    queueResolvedAt: toIso(queueRow.resolvedAt ?? toIsoNow()),
  };
}

async function autoRejectInTx(
  client: ClientBase,
  row: IntentSnapshotRow,
  approvalId: string,
  expiresAt: Date,
): Promise<ApproveSnapshot> {
  const queueRow = await approvalsRepo.rejectWith(client, approvalId);
  if (queueRow === null) {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      "expired-in-tx queue CAS missed despite FOR UPDATE",
    );
  }
  const ok = await approvalIntentsRepo.markDecisionWith(client, {
    approvalId,
    kind: "rejected",
    reason: TOOL_RESULT_EXPIRED_REASON,
    idempotencyKey: approvalId,
    refusalReason: studioExpiryRefusalReason(row),
  });
  if (!ok) {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      "expired-in-tx intent CAS missed despite decision=null",
    );
  }
  return {
    type: "expired_in_tx",
    row,
    expiredAt: expiresAt.toISOString(),
    queueResolvedAt: toIso(queueRow.resolvedAt ?? toIsoNow()),
  };
}

/**
 * B-001 — flip queue+intent to `rejected` in the SAME locked tx that read the
 * drifted permission, then return the `policy_drift_blocked` snapshot. Mirrors
 * `autoRejectInTx` (expired path) — the row is locked `FOR UPDATE`, so the
 * `decision IS NULL` / `status='pending'` CAS predicates hold and a missed CAS
 * is a real inconsistency. No approved decision is ever written; the post-tx
 * side effects render a rejection tool-result, never an approved dispatch.
 */
interface DriftVerdict {
  readonly driftKind: ApprovalDriftKind;
  readonly refusalReason: ApprovalRefusalReason | null;
  readonly livePermission: Permission;
}

/**
 * Lock the project row and decide whether the authority behind this Studio
 * approval still holds. `null` means it does.
 *
 * A missing project is `project_deleted` and NOT a "not found": the intent row
 * survives on purpose (migration 086 declares the reference with no cascade),
 * because the record that an external agent asked Vex to act is exactly what
 * must not vanish with the project.
 */
async function readProjectDrift(
  client: ClientBase,
  row: IntentSnapshotRow,
): Promise<DriftVerdict | null> {
  if (row.project_id === null) {
    return {
      driftKind: "project_deleted",
      refusalReason: "project_deleted",
      livePermission: row.session_permission_live,
    };
  }
  const res = await client.query<{ scope_version: number; permission: Permission }>(
    "SELECT scope_version, permission FROM projects WHERE id = $1 FOR UPDATE",
    [row.project_id],
  );
  const project = res.rows[0];
  if (project === undefined) {
    return {
      driftKind: "project_deleted",
      refusalReason: "project_deleted",
      livePermission: row.session_permission_live,
    };
  }
  if (
    row.scope_version_at_enqueue !== null
    && Number(project.scope_version) !== Number(row.scope_version_at_enqueue)
  ) {
    return {
      driftKind: "scope_changed",
      refusalReason: "scope_changed",
      livePermission: project.permission,
    };
  }
  if (
    isPermissionMoreRestrictive(
      project.permission,
      row.queue_permission_at_enqueue,
    )
  ) {
    // Policy drift, not a refusal by an owner: nobody cancelled this action,
    // the permission it was granted under simply no longer exists.
    return {
      driftKind: "project_permission",
      refusalReason: null,
      livePermission: project.permission,
    };
  }
  return null;
}

async function policyDriftRejectInTx(
  client: ClientBase,
  row: IntentSnapshotRow,
  approvalId: string,
  drift: DriftVerdict,
): Promise<ApproveSnapshot> {
  const queueRow = await approvalsRepo.rejectWith(client, approvalId);
  if (queueRow === null) {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      "policy-drift queue CAS missed despite FOR UPDATE",
    );
  }
  const ok = await approvalIntentsRepo.markDecisionWith(client, {
    approvalId,
    kind: "rejected",
    reason: TOOL_RESULT_POLICY_DRIFT_REASON,
    idempotencyKey: approvalId,
    refusalReason: drift.refusalReason,
  });
  if (!ok) {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      "policy-drift intent CAS missed despite decision=null",
    );
  }
  return {
    type: "policy_drift_blocked",
    row,
    queueResolvedAt: toIso(queueRow.resolvedAt ?? toIsoNow()),
    reason: TOOL_RESULT_POLICY_DRIFT_REASON,
    permissionAtEnqueue: row.queue_permission_at_enqueue,
    livePermission: drift.livePermission,
    driftKind: drift.driftKind,
    refusalReason: drift.refusalReason,
  };
}

export async function buildRejectSnapshot(
  client: ClientBase,
  approvalId: string,
  reason: string,
): Promise<RejectSnapshot> {
  const row = await lockAndLoadSnapshot(client, approvalId);
  if (row === null) return { type: "not_found" };

  if (row.decision !== null) {
    if (row.queue_status === "pending") {
      throw new ApprovalDecisionInconsistencyError(
        approvalId,
        `decision=${row.decision} but queue.status=pending`,
      );
    }
    if (row.decision === "approved") {
      return { type: "already_approved", row };
    }
    return { type: "cached_rejected", row };
  }

  if (row.queue_status !== "pending") {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      `queue.status=${row.queue_status} but decision=null`,
    );
  }

  const queueRow = await approvalsRepo.rejectWith(client, approvalId);
  if (queueRow === null) {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      "reject queue CAS missed despite FOR UPDATE",
    );
  }
  const ok = await approvalIntentsRepo.markDecisionWith(client, {
    approvalId,
    kind: "rejected",
    reason,
    idempotencyKey: approvalId,
    refusalReason:
      reason === TOOL_RESULT_EXPIRED_REASON
        ? studioExpiryRefusalReason(row)
        : null,
  });
  if (!ok) {
    throw new ApprovalDecisionInconsistencyError(
      approvalId,
      "reject intent CAS missed despite decision=null",
    );
  }
  return {
    type: "rejected_in_tx",
    row,
    queueResolvedAt: toIso(queueRow.resolvedAt ?? toIsoNow()),
    reason,
  };
}

/**
 * `'expired'` for a Studio row, `null` for every agent row.
 *
 * The machine fact belongs in `refusal_reason` because the alternative is
 * pattern-matching `decision_reason` prose, which is a human sentence that may
 * be reworded or localized at any time. An agent row keeps the column NULL:
 * nothing reads it there, and writing it would change a shape the agent paths
 * already agree on.
 */
function studioExpiryRefusalReason(
  row: IntentSnapshotRow,
): ApprovalRefusalReason | null {
  return row.origin === "studio_mcp" ? "expired" : null;
}
