/**
 * Desk settlement writes (migration 165). Same table, fourth reason to change:
 * a desk row has no transcript message to point at and no Studio settlement
 * blob to release, so its dispatch settles on the row alone. The desk reads
 * the tool outcome from the approve reply; the row keeps the durable status
 * and the result hash.
 *
 * Both writes are fenced on `origin = 'desk'` so no agent or Studio row can
 * be settled through this module by mistake.
 */

import type { ClientBase } from "pg";

import { query } from "../../client.js";
import type { ApprovalExecutionStatus } from "../approval-intents.js";

const COMMIT_DESK_SETTLEMENT_SQL = `UPDATE approval_intents
   SET execution_status      = $2,
       execution_result_hash = COALESCE($3, execution_result_hash)
 WHERE approval_id      = $1
   AND origin           = 'desk'
   AND execution_status = 'dispatching'
 RETURNING approval_id`;

/** `dispatching → succeeded | failed | indeterminate`; false when superseded. */
export async function commitDeskSettlementWith(
  client: ClientBase,
  input: {
    readonly approvalId: string;
    readonly status: Exclude<ApprovalExecutionStatus, "not_started" | "dispatching">;
    readonly resultHash: string | null;
  },
): Promise<boolean> {
  const res = await client.query(COMMIT_DESK_SETTLEMENT_SQL, [
    input.approvalId,
    input.status,
    input.resultHash,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Process-start recovery. A desk dispatch runs inside the main process that
 * took the slot; a row still `dispatching` when a new process starts was
 * abandoned by a crash or a quit mid-dispatch, and nothing can prove whether
 * the order reached the sequencer. It is marked indeterminate and never
 * retried - the same rule the agent and Studio lanes apply.
 */
export async function markAbandonedDeskDispatchesIndeterminate(
  startedBefore: Date | string,
): Promise<
  readonly string[]
> {
  const cutoff = typeof startedBefore === "string"
    ? startedBefore
    : startedBefore.toISOString();
  const rows = await query<{ approval_id: string }>(
    `UPDATE approval_intents
        SET execution_status = 'indeterminate'
      WHERE origin = 'desk'
        AND decision = 'approved'
        AND execution_status = 'dispatching'
        AND (dispatch_started_at IS NULL OR dispatch_started_at < $1)
  RETURNING approval_id`,
    [cutoff],
  );
  return rows.map((row) => row.approval_id);
}

/** Desk rows that are approved but still prove the tool never started. */
export async function listUnstartedDeskApprovals(): Promise<readonly string[]> {
  const rows = await query<{ approval_id: string }>(
    `SELECT approval_id
       FROM approval_intents
      WHERE origin = 'desk'
        AND decision = 'approved'
        AND execution_status = 'not_started'
      ORDER BY decided_at ASC, approval_id ASC`,
  );
  return rows.map((row) => row.approval_id);
}
