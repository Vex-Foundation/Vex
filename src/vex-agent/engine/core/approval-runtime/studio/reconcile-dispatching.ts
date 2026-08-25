/**
 * The ABANDONED-DISPATCH reconciler for Vex Studio intents.
 *
 * ## Why a row can be abandoned at all
 *
 * A Studio dispatch is bracketed by two writes: the slot claim
 * (`not_started -> dispatching`) commits before the call runs, and the
 * settlement commits after it. Between them the process can die - a crash, a
 * kill, a machine losing power. The row is then `dispatching` with no writer
 * alive, and nothing else in the system owns it: the agent lifecycle scans
 * exclude Studio rows, and the expiry sweep only looks at UNDECIDED ones. So
 * this reconciler exists, and it runs at process START, which is the one moment
 * at which "still dispatching" provably means "abandoned": this process is the
 * only one that can write those rows and it has just begun.
 *
 * ## Why `indeterminate` and never `failed`
 *
 * The dispatch MAY have run. It may have broadcast a transaction. Nothing
 * readable from here can tell, so the honest terminal state is the one that
 * says the outcome is unknown, and the rule that follows from it is absolute:
 * an approved money-path call is never re-dispatched to find out. Recording
 * `failed` would invite exactly the retry that must not happen.
 *
 * ## BOUNDED, and it moves forward
 *
 * The scan is paged with a keyset cursor rather than loading every historical
 * row at once, and rather than re-querying the same predicate: this reconciler
 * WRITES the rows it reads, so a row it cannot write would be handed back for
 * ever by a `LIMIT`-only loop. The cursor advances past it, and the next
 * process start tries it again.
 *
 * ## Write first, announce second
 *
 * Same split as `refuse.ts`: the CAS commits, and only then may the settlement
 * be announced, because a subscriber reads the row by id on that signal.
 */

import logger from "@utils/logger.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { emitStudioSettlement } from "@vex-agent/engine/runtime/studio-settlement-bus.js";

import { buildStudioRefusalSettlement } from "./refusal-settlement.js";

/** A row this reconciler actually flipped. Ids only; nothing model-visible. */
export interface ReconciledStudioDispatch {
  readonly approvalId: string;
  readonly projectId: string | null;
}

/**
 * The page size and the page cap. The cap is a bound, not a filter: it is
 * logged when it is hit, and the rows beyond it are picked up by the next
 * process start rather than silently dropped.
 */
const RECONCILE_PAGE_SIZE = 200;
const MAX_RECONCILE_PAGES = 50;

/**
 * The cause stored for an APPROVED row that never started. It says the two
 * things that matter and neither more nor less: this process is new, and the
 * action did not run. `buildStudioRefusalSettlement` completes the sentence
 * with "Nothing was executed and no funds moved. Request the action again if
 * you still want it."
 */
const UNSTARTED_CAUSE =
  "Vex restarted before this approved action could start";

const ABANDONED_CAUSE =
  "Vex stopped while this approved action was running, so Vex cannot prove "
  + "whether it took effect. It was NOT retried and it will not be. Check the "
  + "outcome yourself before asking for it again";

/**
 * Flip every Studio row still marked `dispatching` to `indeterminate`, storing
 * the sentence that says why. Returns the rows this call flipped, for the
 * caller to announce AFTER it returns.
 *
 * Each row is its own transaction: one row that cannot be written must not stop
 * the rest, and there is no invariant that spans them.
 */
export async function reconcileAbandonedStudioDispatches(): Promise<
  readonly ReconciledStudioDispatch[]
> {
  const settlement = buildStudioRefusalSettlement(ABANDONED_CAUSE);
  const reconciled: ReconciledStudioDispatch[] = [];
  let after: approvalIntentsRepo.DispatchingStudioCursor | null = null;
  for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
    const candidates = await approvalIntentsRepo.listDispatchingStudioApprovals({
      limit: RECONCILE_PAGE_SIZE,
      after,
    });
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      after = candidate.cursor;
      try {
        const flipped = await withTransaction((client) =>
          approvalIntentsRepo.casMarkIndeterminateWithSettlementWith(client, {
            approvalId: candidate.approvalId,
            settlementJson: settlement.settlementJson,
            settlementBytes: settlement.settlementBytes,
            resultHash: settlement.resultHash,
          }),
        );
        if (flipped) {
          reconciled.push({
            approvalId: candidate.approvalId,
            projectId: candidate.projectId,
          });
        }
      } catch (cause) {
        logger.warn("engine.studio.abandoned_dispatch_write_failed", {
          approvalId: candidate.approvalId,
          errorName: cause instanceof Error ? cause.name : "unknown",
        });
      }
    }
    if (candidates.length < RECONCILE_PAGE_SIZE) break;
    if (page === MAX_RECONCILE_PAGES - 1) {
      // The bound was reached, and it is REPORTED: rows past it are still
      // `dispatching` and belong to the next process start.
      logger.warn("engine.studio.abandoned_dispatch_scan_bounded", {
        pages: MAX_RECONCILE_PAGES,
        pageSize: RECONCILE_PAGE_SIZE,
      });
    }
  }
  if (reconciled.length > 0) {
    logger.info("engine.studio.abandoned_dispatches_reconciled", {
      count: reconciled.length,
    });
  }
  return reconciled;
}

/**
 * Terminally refuse every Studio row that is APPROVED but never started, in the
 * SAME bounded, paged, one-transaction-per-row shape as the scan above.
 *
 * ## Why this row is the more dangerous of the two
 *
 * `dispatching` means an action may already have run. `not_started` means it
 * has NOT run and STILL CAN: it is exactly the state
 * `casClaimStudioDispatchSlotWith` accepts. A row left here by a dead process,
 * or by a terminal refusal write that failed, is an approved money-path action
 * sitting in the database waiting for any future dispatcher, usually behind a
 * caller that was already told it did not happen.
 *
 * ## Why refusing it at process start is safe
 *
 * Two facts, together:
 *
 *   - the readiness barrier runs this BEFORE anything in this process can
 *     dispatch, so no claim can be in flight here;
 *   - the approve continuation that would have claimed the slot belonged to a
 *     process that no longer exists, and cannot come back for the row.
 *
 * So `not_started` at process start provably means "nobody is going to start
 * this", and `failed` with the `stopped` cause is the honest terminal state:
 * unlike the `dispatching` rows, nothing ran, so `indeterminate` would overstate
 * the uncertainty and invite a check the user does not need to make.
 */
export async function reconcileUnstartedStudioApprovals(): Promise<
  readonly ReconciledStudioDispatch[]
> {
  const settlement = buildStudioRefusalSettlement(UNSTARTED_CAUSE);
  const reconciled: ReconciledStudioDispatch[] = [];
  let after: approvalIntentsRepo.DispatchingStudioCursor | null = null;
  for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
    const candidates = await approvalIntentsRepo.listUnstartedStudioApprovals({
      limit: RECONCILE_PAGE_SIZE,
      after,
    });
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      after = candidate.cursor;
      try {
        const refused = await withTransaction((client) =>
          approvalIntentsRepo.casRefuseStudioBeforeDispatchWith(client, {
            approvalId: candidate.approvalId,
            refusalReason: "stopped",
            settlementJson: settlement.settlementJson,
            settlementBytes: settlement.settlementBytes,
            resultHash: settlement.resultHash,
          }),
        );
        if (refused) {
          reconciled.push({
            approvalId: candidate.approvalId,
            projectId: candidate.projectId,
          });
        }
      } catch (cause) {
        logger.warn("engine.studio.unstarted_approval_write_failed", {
          approvalId: candidate.approvalId,
          errorName: cause instanceof Error ? cause.name : "unknown",
        });
      }
    }
    if (candidates.length < RECONCILE_PAGE_SIZE) break;
    if (page === MAX_RECONCILE_PAGES - 1) {
      logger.warn("engine.studio.unstarted_approval_scan_bounded", {
        pages: MAX_RECONCILE_PAGES,
        pageSize: RECONCILE_PAGE_SIZE,
      });
    }
  }
  if (reconciled.length > 0) {
    logger.info("engine.studio.unstarted_approvals_refused", {
      count: reconciled.length,
    });
  }
  return reconciled;
}

/**
 * Emit one settlement event per reconciled row. Call ONLY after
 * `reconcileAbandonedStudioDispatches` has returned: every write it reports is
 * committed by then.
 */
export function announceStudioReconciliations(
  reconciled: readonly ReconciledStudioDispatch[],
): void {
  for (const row of reconciled) {
    emitStudioSettlement({
      approvalId: row.approvalId,
      projectId: row.projectId,
      outcome: "indeterminate",
    });
  }
}

/**
 * Emit one settlement event per row refused by
 * `reconcileUnstartedStudioApprovals`. A separate function from the one above
 * because the OUTCOME differs and must not be guessed from the row list: these
 * rows never dispatched, so they are `rejected`, not `indeterminate`.
 */
export function announceStudioUnstartedRefusals(
  reconciled: readonly ReconciledStudioDispatch[],
): void {
  for (const row of reconciled) {
    emitStudioSettlement({
      approvalId: row.approvalId,
      projectId: row.projectId,
      outcome: "rejected",
    });
  }
}
