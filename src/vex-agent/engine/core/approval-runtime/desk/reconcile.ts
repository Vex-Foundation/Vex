/**
 * Process-start recovery for desk rows (migration 164), the desk counterpart
 * of `../studio/reconcile-dispatching.ts`: a row still `dispatching` when the
 * process starts was abandoned mid-call, and nobody can prove what the
 * exchange did with it. It becomes `indeterminate`, never a retry.
 */

import { markAbandonedDeskDispatchesIndeterminate } from "@vex-agent/db/repos/approval-intents.js";
import logger from "@utils/logger.js";

export async function reconcileAbandonedDeskDispatches(): Promise<readonly string[]> {
  const approvalIds = await markAbandonedDeskDispatchesIndeterminate();
  if (approvalIds.length > 0) {
    logger.warn("engine.desk.abandoned_dispatches_reconciled", {
      count: approvalIds.length,
      approvalIds,
    });
  }
  return approvalIds;
}
