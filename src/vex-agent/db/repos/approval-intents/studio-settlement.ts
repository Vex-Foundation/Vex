/**
 * Approval intents - Vex Studio settlement writes (migration 086).
 *
 * A THIRD reason to change, next to the decision CAS (`../approval-intents.ts`)
 * and the agent execution lifecycle (`./lifecycle.ts`). Those two settle an
 * approved agent action by pointing at the transcript row that carries its
 * result. A Studio call has no transcript: the caller is an external coding
 * agent blocked on an MCP request, and the durable record of what happened IS
 * the row. So these writes store the whole result on the intent and never
 * touch `result_message_id`.
 *
 * Every write here is compare-and-set, for the same reason as the lifecycle
 * module: the IPC decision path, the broker's expiry timer, the refusal owners
 * and the scheduled reconciler can all legitimately reach for the same row, and
 * the predicate is what makes "the Studio call dispatched twice" impossible
 * rather than merely unlikely.
 */

import type { ClientBase, PoolClient } from "pg";

import { query } from "../../client.js";
import type {
  ApprovalDecision,
  ApprovalExecutionStatus,
  ApprovalRefusalReason,
  StudioPostDecisionRefusalReason,
} from "../approval-intents.js";
import { toIsoOrNull } from "./row-mapping.js";

/**
 * Claim the Studio dispatch slot: `not_started -> dispatching`, but ONLY while
 * the durable dispatch generation this intent was enqueued under is still the
 * current one.
 *
 * ONE STATEMENT, and that is the whole point. An in-memory generation is not a
 * linearization point: a dispatcher can read generation N, await, have the user
 * lock Vex, and still commit its claim. Reading the generation inside the same
 * UPDATE that takes the slot makes a COMMITTED CLAIM MEAN "the dispatch began
 * before the lock" - there is no interleaving in which both the advance and a
 * stale claim commit, because the row `FOR SHARE` here conflicts with the
 * advance's row lock.
 *
 * Zero rows therefore has exactly three causes, and all three are correct
 * refusals: another writer already owns the dispatch, the row is not
 * `not_started`, or Vex was locked or unlocked after the enqueue.
 */
const CAS_CLAIM_STUDIO_SLOT_SQL = `UPDATE approval_intents
   SET execution_status    = 'dispatching',
       dispatch_started_at = NOW()
 WHERE approval_id      = $1
   AND execution_status = 'not_started'
   AND origin           = 'studio_mcp'
   AND dispatch_generation_at_enqueue = (
         SELECT dispatch_generation FROM studio_runtime_gate WHERE id = 1 FOR SHARE
       )
 RETURNING approval_id`;

export async function casClaimStudioDispatchSlotWith(
  client: PoolClient,
  approvalId: string,
): Promise<boolean> {
  const res = await client.query(CAS_CLAIM_STUDIO_SLOT_SQL, [approvalId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Refuse an APPROVED Studio intent BEFORE anything dispatched:
 * `not_started -> failed`, with the machine cause and a settlement body that
 * says what did not happen.
 *
 * ONE STATEMENT, and it races the slot claim ON PURPOSE. Both predicates
 * require `execution_status = 'not_started'`, so for any one row exactly one of
 * them can win: either the dispatcher took the slot (and this returns `false`,
 * overwriting nothing), or this refusal made the row terminal (and the slot
 * claim matches zero rows). There is no interleaving that leaves the row both
 * refused and dispatching, and none that leaves it approvable after a refusal.
 *
 * `false` therefore means "another writer owns this row"; the caller reports
 * the row's own state and must not write a second, contradictory outcome.
 *
 * `decision = 'approved'` is part of the predicate because this statement is
 * the POST-decision refusal. An undecided row belongs to the pending-refusal
 * primitive, which writes the decision as well; letting this one match it
 * would settle the execution of a row nobody has decided.
 */
const CAS_REFUSE_STUDIO_BEFORE_DISPATCH_SQL = `UPDATE approval_intents
   SET execution_status      = 'failed',
       refusal_reason        = $2,
       settlement            = $3::jsonb,
       settlement_bytes      = $4,
       execution_result_hash = COALESCE($5, execution_result_hash)
 WHERE approval_id      = $1
   AND origin           = 'studio_mcp'
   AND decision         = 'approved'
   AND execution_status = 'not_started'
 RETURNING approval_id`;

export async function casRefuseStudioBeforeDispatchWith(
  client: ClientBase,
  input: {
    readonly approvalId: string;
    readonly refusalReason: StudioPostDecisionRefusalReason;
    /** Serialized JSON body, or `null` when nothing could be serialized. */
    readonly settlementJson: string | null;
    readonly settlementBytes: number | null;
    readonly resultHash: string | null;
  },
): Promise<boolean> {
  const res = await client.query(CAS_REFUSE_STUDIO_BEFORE_DISPATCH_SQL, [
    input.approvalId,
    input.refusalReason,
    input.settlementJson,
    input.settlementBytes,
    input.resultHash,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * `dispatching -> indeterminate` AND the preserved settlement, in ONE
 * statement.
 *
 * It is one statement because it cannot be two. A status flip followed by
 * `commitStudioSettlementWith` can never work: that second CAS is fenced on
 * `dispatching`, which the first statement has just left, so the body would be
 * silently dropped every single time. This runs because a write already failed
 * and the dispatch ALREADY RAN, so whatever text survived is the only evidence
 * of what happened and must land with the status that admits it is unproven.
 */
const CAS_MARK_INDETERMINATE_WITH_SETTLEMENT_SQL = `UPDATE approval_intents
   SET execution_status      = 'indeterminate',
       settlement            = COALESCE($2::jsonb, settlement),
       settlement_bytes      = COALESCE($3, settlement_bytes),
       execution_result_hash = COALESCE($4, execution_result_hash)
 WHERE approval_id      = $1
   AND origin           = 'studio_mcp'
   AND execution_status = 'dispatching'
 RETURNING approval_id`;

export async function casMarkIndeterminateWithSettlementWith(
  client: ClientBase,
  input: {
    readonly approvalId: string;
    readonly settlementJson: string | null;
    readonly settlementBytes: number | null;
    readonly resultHash: string | null;
  },
): Promise<boolean> {
  const res = await client.query(CAS_MARK_INDETERMINATE_WITH_SETTLEMENT_SQL, [
    input.approvalId,
    input.settlementJson,
    input.settlementBytes,
    input.resultHash,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/** One page of abandoned rows, plus the cursor that continues after it. */
export interface DispatchingStudioApproval {
  readonly approvalId: string;
  readonly projectId: string | null;
  /** Opaque to the caller: hand it back as `after` for the next page. */
  readonly cursor: DispatchingStudioCursor;
}

export interface DispatchingStudioCursor {
  readonly createdAt: string;
  readonly approvalId: string;
}

/**
 * ONE BOUNDED PAGE of Studio rows still marked `dispatching`, oldest first.
 * Read at process start by the abandoned-dispatch reconciler: this process is
 * the only writer that could have owned those rows, and it has just started, so
 * each one belonged to a dead process and nobody will ever settle it.
 *
 * Paged with a KEYSET rather than a bare `LIMIT` loop, because the caller
 * writes the rows it reads: a row that could not be flipped stays
 * `dispatching`, and a re-query from the top would hand it back forever. The
 * cursor moves past it instead, so one unwritable row cannot stall the sweep.
 */
export async function listDispatchingStudioApprovals(input?: {
  readonly limit?: number;
  readonly after?: DispatchingStudioCursor | null;
}): Promise<readonly DispatchingStudioApproval[]> {
  const limit = input?.limit ?? 200;
  const after = input?.after ?? null;
  const rows = await query<{
    approval_id: string;
    project_id: string | null;
    created_at: string | Date;
  }>(
    `SELECT approval_id, project_id, created_at
       FROM approval_intents
      WHERE origin = 'studio_mcp'
        AND execution_status = 'dispatching'
        AND ($2::timestamptz IS NULL
             OR (created_at, approval_id) > ($2::timestamptz, $3::text))
      ORDER BY created_at ASC, approval_id ASC
      LIMIT $1`,
    [limit, after?.createdAt ?? null, after?.approvalId ?? null],
  );
  return rows.map((row) => {
    const createdAt = toIsoOrNull(row.created_at) ?? new Date(0).toISOString();
    return {
      approvalId: row.approval_id,
      projectId: row.project_id,
      cursor: { createdAt, approvalId: row.approval_id },
    };
  });
}

/**
 * ONE BOUNDED PAGE of Studio rows that are APPROVED but never started, oldest
 * first, with the SAME keyset paging and for the same reason as the
 * `dispatching` scan above.
 *
 * Read at process start, next to that scan, because the two cover the two ways
 * an approved Studio row can be left with no owner:
 *
 *   - `dispatching`   a process died between the slot claim and the settlement;
 *   - `not_started`   a process died, or its terminal refusal write failed,
 *                     between the human's approval and the slot claim.
 *
 * The second one is the more dangerous of the two, because `not_started` is
 * exactly the state the dispatch-slot CAS accepts: such a row is still able to
 * RUN, on behalf of a caller that has usually already been told it would not.
 * Nothing else reaches it - the expiry sweep scans `decision IS NULL` only, and
 * the agent lifecycle scans exclude Studio rows.
 *
 * Safe to treat as abandoned ONLY at process start, and only behind the
 * readiness barrier: no dispatch can be in flight in a process that has just
 * begun, and the approve continuation of a process that has died can never come
 * back for these rows.
 */
export async function listUnstartedStudioApprovals(input?: {
  readonly limit?: number;
  readonly after?: DispatchingStudioCursor | null;
}): Promise<readonly DispatchingStudioApproval[]> {
  const limit = input?.limit ?? 200;
  const after = input?.after ?? null;
  const rows = await query<{
    approval_id: string;
    project_id: string | null;
    created_at: string | Date;
  }>(
    `SELECT approval_id, project_id, created_at
       FROM approval_intents
      WHERE origin = 'studio_mcp'
        AND decision = 'approved'
        AND execution_status = 'not_started'
        AND ($2::timestamptz IS NULL
             OR (created_at, approval_id) > ($2::timestamptz, $3::text))
      ORDER BY created_at ASC, approval_id ASC
      LIMIT $1`,
    [limit, after?.createdAt ?? null, after?.approvalId ?? null],
  );
  return rows.map((row) => {
    const createdAt = toIsoOrNull(row.created_at) ?? new Date(0).toISOString();
    return {
      approvalId: row.approval_id,
      projectId: row.project_id,
      cursor: { createdAt, approvalId: row.approval_id },
    };
  });
}

/**
 * Settle a dispatched Studio call: `dispatching -> succeeded | failed |
 * indeterminate`, storing the whole result and its byte size.
 *
 * FENCED on `execution_status = 'dispatching'`, the same fence as
 * `commitExecutionResultWith` and for the same reason: the slot claim is the
 * only way into `dispatching`, so this predicate says exactly "the writer that
 * took the slot is still the writer settling it". A `false` return means the
 * row left `dispatching` underneath this caller (reconciled to
 * `indeterminate`, or already settled) and the caller must not persist a
 * second, contradictory outcome.
 *
 * `settlement` is passed as an already-serialized JSON string so the caller's
 * codec, not this repo, decides how a `ToolResult` becomes JSON - and so
 * `settlementBytes` can describe the exact body that is stored.
 */
const COMMIT_STUDIO_SETTLEMENT_SQL = `UPDATE approval_intents
   SET execution_status      = $2,
       execution_result_hash = COALESCE($3, execution_result_hash),
       settlement            = $4::jsonb,
       settlement_bytes      = $5,
       refusal_reason        = COALESCE($6, refusal_reason)
 WHERE approval_id      = $1
   AND origin           = 'studio_mcp'
   AND execution_status = 'dispatching'
 RETURNING approval_id`;

export async function commitStudioSettlementWith(
  client: PoolClient,
  input: {
    readonly approvalId: string;
    readonly status: ApprovalExecutionStatus;
    readonly resultHash: string | null;
    /** Serialized JSON body, or `null` when nothing could be serialized. */
    readonly settlementJson: string | null;
    readonly settlementBytes: number | null;
    /**
     * The machine cause, when this settlement IS a refusal of the claim the
     * same transaction took (the commit-time scope re-check). Omitted for an
     * ordinary result, and never allowed to clear a reason already written:
     * the first owner to name why a row ended keeps it.
     */
    readonly refusalReason?: ApprovalRefusalReason | null;
  },
): Promise<boolean> {
  const res = await client.query(COMMIT_STUDIO_SETTLEMENT_SQL, [
    input.approvalId,
    input.status,
    input.resultHash,
    input.settlementJson,
    input.settlementBytes,
    input.refusalReason ?? null,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * What a settled or refused Studio intent looks like to the main process. Read
 * by id AFTER the settlement bus says the row is durable, so the waiter is
 * always released with committed state rather than with an in-memory guess.
 */
export interface StudioSettlementRow {
  readonly approvalId: string;
  readonly projectId: string | null;
  readonly decision: ApprovalDecision | null;
  readonly decisionReason: string | null;
  readonly refusalReason: ApprovalRefusalReason | null;
  readonly executionStatus: ApprovalExecutionStatus;
  readonly settlement: Record<string, unknown> | null;
  readonly settlementBytes: number | null;
  readonly expiresAt: string | null;
}

export async function getStudioSettlementByApprovalId(
  approvalId: string,
): Promise<StudioSettlementRow | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT approval_id, project_id, decision, decision_reason, refusal_reason,
            execution_status, settlement, settlement_bytes, expires_at
       FROM approval_intents
      WHERE approval_id = $1 AND origin = 'studio_mcp'`,
    [approvalId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    approvalId: row.approval_id as string,
    projectId: row.project_id as string | null,
    decision: row.decision as ApprovalDecision | null,
    decisionReason: row.decision_reason as string | null,
    refusalReason: row.refusal_reason as ApprovalRefusalReason | null,
    executionStatus:
      (row.execution_status as ApprovalExecutionStatus) ?? "not_started",
    settlement: (row.settlement as Record<string, unknown> | null) ?? null,
    settlementBytes:
      row.settlement_bytes === null || row.settlement_bytes === undefined
        ? null
        : Number(row.settlement_bytes),
    expiresAt: toIsoOrNull(row.expires_at as string | Date | null),
  };
}
