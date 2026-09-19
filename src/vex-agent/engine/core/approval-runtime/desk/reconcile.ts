/**
 * Process-start recovery for desk rows (migration 165), the desk counterpart
 * of `../studio/reconcile-dispatching.ts`: a row still `dispatching` when the
 * process starts was abandoned mid-call, and nobody can prove what the
 * exchange did with it. It becomes `indeterminate`, never a retry.
 */

import { withTransaction } from "@vex-agent/db/client.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import logger from "@utils/logger.js";

import { summarizeErrorForLog } from "../helpers.js";
import { applyDeskApproveSideEffects } from "../post-tx/dispatch-approved/desk.js";
import { lockAndLoadSnapshot } from "../snapshot/compare.js";
import {
  finishDeskSettlementRepair,
  listDeskSettlementRepairs,
} from "./repair-registry.js";

export interface DeskApprovalLifecycleResult {
  readonly abandoned: number;
  readonly repaired: number;
  readonly dispatched: number;
  readonly superseded: number;
  readonly errored: number;
}

export async function reconcileAbandonedDeskDispatches(
  startedBefore: Date | string,
): Promise<readonly string[]> {
  const approvalIds = await approvalIntentsRepo
    .markAbandonedDeskDispatchesIndeterminate(startedBefore);
  if (approvalIds.length > 0) {
    logger.warn("engine.desk.abandoned_dispatches_reconciled", {
      count: approvalIds.length,
      approvalIds,
    });
  }
  return approvalIds;
}

/**
 * Scheduled Desk lifecycle floor. A `not_started` approved row is safe to
 * submit through the ordinary dispatch-slot CAS; a remembered settlement
 * repair retries only the terminal database write and can never submit.
 */
export async function reconcileDeskApprovalLifecycle(
  options: { readonly abandonedBefore?: Date | string } = {},
): Promise<DeskApprovalLifecycleResult> {
  let abandoned = 0;
  let repaired = 0;
  let dispatched = 0;
  let superseded = 0;
  let errored = 0;

  if (options.abandonedBefore !== undefined) {
    abandoned = (
      await reconcileAbandonedDeskDispatches(options.abandonedBefore)
    ).length;
  }

  for (const repair of listDeskSettlementRepairs()) {
    try {
      const committed = await withTransaction((client) =>
        approvalIntentsRepo.commitDeskSettlementWith(client, {
          approvalId: repair.approvalId,
          status: "indeterminate",
          resultHash: repair.resultHash,
        }),
      );
      finishDeskSettlementRepair(repair.approvalId);
      if (committed) repaired += 1;
      else superseded += 1;
    } catch (cause) {
      errored += 1;
      const summary = summarizeErrorForLog(cause);
      logger.warn("engine.desk.settlement_repair_failed", {
        approvalId: repair.approvalId,
        errorKind: summary.errorKind,
        errorHash: summary.errorHash,
      });
    }
  }

  const approvalIds = await approvalIntentsRepo.listUnstartedDeskApprovals();
  for (const approvalId of approvalIds) {
    try {
      const row = await withTransaction((client) =>
        lockAndLoadSnapshot(client, approvalId),
      );
      if (
        row === null
        || row.origin !== "desk"
        || row.decision !== "approved"
        || row.execution_status !== "not_started"
      ) {
        superseded += 1;
        continue;
      }

      const queueResolvedAt = row.queue_resolved_at instanceof Date
        ? row.queue_resolved_at.toISOString()
        : row.queue_resolved_at ?? new Date().toISOString();
      const outcome = await applyDeskApproveSideEffects(approvalId, {
        type: "approved_in_tx",
        row,
        queueResolvedAt,
      });
      if (outcome.kind === "dispatched") dispatched += 1;
      else superseded += 1;
    } catch (cause) {
      errored += 1;
      const summary = summarizeErrorForLog(cause);
      logger.warn("engine.desk.unstarted_reconcile_failed", {
        approvalId,
        errorKind: summary.errorKind,
        errorHash: summary.errorHash,
      });
    }
  }

  return { abandoned, repaired, dispatched, superseded, errored };
}
