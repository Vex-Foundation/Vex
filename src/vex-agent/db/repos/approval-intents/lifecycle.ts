/**
 * Approval intents — execution lifecycle state machine (migration 056).
 *
 * Separate from the decision repo (`../approval-intents.ts`, which owns
 * enqueue + the approve/reject decision CAS) because this module has a
 * different reason to change: it is the durable record of what happened to an
 * approved action AFTER the user decided, and of whether the agent has been
 * resumed to observe it.
 *
 * Every write here is compare-and-set. Two writers can legitimately race for
 * the same approval — the IPC decision path and the scheduled reconciler — and
 * the CAS predicate is what makes "the approved tool dispatched twice"
 * impossible rather than merely unlikely.
 *
 * Re-exported from `../approval-intents.ts`, so the repo's public surface
 * (`import * as approvalIntentsRepo`) is unchanged.
 */

import type { PoolClient } from "pg";

import { query, execute } from "../../client.js";
import { APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES } from "../../../engine/types.js";
import type {
  ApprovalDecision,
  ApprovalExecutionStatus,
} from "../approval-intents.js";
import { toIsoOrNull } from "./row-mapping.js";

// ── CAS writes ──────────────────────────────────────────────────────────

/**
 * Claim the dispatch slot: `not_started -> dispatching`, stamping
 * `dispatch_started_at` in the same statement so the reconciler always has an
 * age for a dispatch it may later find abandoned.
 *
 * Returns `true` only for the writer that flipped the row. A `false` return
 * means another writer already owns this dispatch — the caller MUST NOT
 * dispatch the tool. This is the single guard that keeps an approved
 * money-path action from executing twice.
 */
const CAS_MARK_DISPATCHING_SQL = `UPDATE approval_intents
   SET execution_status    = 'dispatching',
       dispatch_started_at = NOW()
 WHERE approval_id      = $1
   AND execution_status = 'not_started'
 RETURNING approval_id`;

export async function casMarkDispatching(approvalId: string): Promise<boolean> {
  const rows = await query<{ approval_id: string }>(CAS_MARK_DISPATCHING_SQL, [
    approvalId,
  ]);
  return rows.length > 0;
}

/**
 * Commit the execution outcome AND the id of the transcript row that carries
 * it, in the caller's transaction. Pairing these two writes with the
 * `messages` INSERT is what makes "succeeded with no tool result" — and its
 * mirror, a tool result no resume can find — unrepresentable.
 *
 * FENCED on `execution_status = 'dispatching'`, and the caller MUST treat a
 * `false` return as fatal to its transaction. Without the fence a dispatcher
 * that woke up after the reconciler had already declared its outcome
 * `indeterminate` would overwrite that terminal verdict with a
 * success/failure it can no longer prove, AND append a second tool result for
 * a tool call that already has one. The dispatch slot CAS
 * (`casMarkDispatching`) is the only way into `dispatching`, so this predicate
 * says exactly "the writer that took the slot is still the writer settling it".
 */
const COMMIT_EXECUTION_RESULT_SQL = `UPDATE approval_intents
   SET execution_status      = $2,
       execution_result_hash = COALESCE($3, execution_result_hash),
       result_message_id     = $4
 WHERE approval_id      = $1
   AND execution_status = 'dispatching'
 RETURNING approval_id`;

/**
 * `true` when this writer still owned the dispatch and the result landed.
 * `false` means the row left `dispatching` underneath us (reconciled to
 * `indeterminate`, or already settled) — the caller must roll back rather
 * than persist a second, contradictory outcome.
 */
export async function commitExecutionResultWith(
  client: PoolClient,
  input: {
    readonly approvalId: string;
    readonly status: ApprovalExecutionStatus;
    readonly resultHash: string | null;
    readonly resultMessageId: number;
  },
): Promise<boolean> {
  const res = await client.query(COMMIT_EXECUTION_RESULT_SQL, [
    input.approvalId,
    input.status,
    input.resultHash,
    input.resultMessageId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Record the transcript row for a decision that never dispatched a tool
 * (reject / expire / policy-drift). `execution_status` is deliberately
 * untouched — those rows stay `not_started` because nothing ran — but the
 * result id still makes them eligible for the durable resume path, so a
 * rejection in a chat session cannot silently strand the agent either.
 */
const ATTACH_RESULT_MESSAGE_SQL = `UPDATE approval_intents
   SET result_message_id = $2
 WHERE approval_id = $1`;

export async function attachResultMessageWith(
  client: PoolClient,
  approvalId: string,
  resultMessageId: number,
): Promise<void> {
  await client.query(ATTACH_RESULT_MESSAGE_SQL, [approvalId, resultMessageId]);
}

/**
 * Attempt audit ONLY — never a gate. A crash after this stamp but before the
 * lease-held core began consuming must still recover, so no reader may treat
 * `resumed_at` as proof that a resume happened.
 */
const MARK_RESUME_ATTEMPTED_SQL = `UPDATE approval_intents
   SET resumed_at = NOW()
 WHERE approval_id = $1`;

export async function markResumeAttempted(approvalId: string): Promise<void> {
  await execute(MARK_RESUME_ATTEMPTED_SQL, [approvalId]);
}

/**
 * The COMPLETION marker — the single fact that ends resume eligibility.
 *
 * Written ONCE, after the resumed turn core has durably returned and while its
 * lease is still held. `true` means this caller recorded the completion;
 * `false` means an earlier attempt had already recorded it, which is only
 * reachable when `hasResumeCompleted` vetoed this attempt's turn.
 *
 * It is NOT the in-progress claim, and must never be moved back to the start of
 * the turn. Mutual exclusion between resumes is the runner lease's job: every
 * resume path holds the session/run lease from before the first side effect
 * until after this write, so two resumes cannot overlap. What this marker adds
 * is protection against a LATER, non-overlapping pass — the end-of-turn hook or
 * the five-minute reconciler — waking the agent a second time for a result it
 * has already observed.
 *
 * Stamping it at the START instead is the defect this column has grown twice:
 * it makes every crash between the stamp and the end of the turn permanent,
 * because the row leaves every recovery scan while the agent was never woken.
 */
const CAS_MARK_RESUME_CONSUMED_SQL = `UPDATE approval_intents
   SET resume_consumed_at = NOW()
 WHERE approval_id           = $1
   AND resume_consumed_at IS NULL
 RETURNING approval_id`;

export async function casMarkResumeConsumed(
  approvalId: string,
): Promise<boolean> {
  const rows = await query<{ approval_id: string }>(
    CAS_MARK_RESUME_CONSUMED_SQL,
    [approvalId],
  );
  return rows.length > 0;
}

/**
 * Has an EARLIER attempt already carried this resume all the way to
 * completion?
 *
 * The stale-snapshot guard. An attempt is selected from a row read taken before
 * the lease was claimed, so between that read and the claim another attempt may
 * have resumed the agent and finished. The turn core asks this immediately
 * before it begins consuming and abandons the turn on `true`.
 *
 * A missing row answers `false` — "nothing proves this was already delivered".
 * Waking the agent for a result it can see in its own transcript is a
 * recoverable annoyance; suppressing a wake that never happened is the
 * unrecoverable direction, and this predicate fails towards the recoverable
 * one.
 */
const HAS_RESUME_COMPLETED_SQL = `SELECT approval_id
   FROM approval_intents
  WHERE approval_id        = $1
    AND resume_consumed_at IS NOT NULL`;

export async function hasResumeCompleted(approvalId: string): Promise<boolean> {
  const rows = await query<{ approval_id: string }>(HAS_RESUME_COMPLETED_SQL, [
    approvalId,
  ]);
  return rows.length > 0;
}

/**
 * Read the `approval_resolved` cue slot under a row lock, in the caller's
 * transaction. `null` means no cue has been recorded for this approval yet and
 * the caller owns the right to write one; the lock is held until the caller's
 * transaction ends, so the read and the matching
 * `attachResumeCueMessageWith` + transcript INSERT are one indivisible step.
 *
 * A missing row also answers `null`, for the same fail-towards-recoverable
 * reason as `hasResumeCompleted`.
 */
const LOCK_RESUME_CUE_MESSAGE_SQL = `SELECT resume_cue_message_id
   FROM approval_intents
  WHERE approval_id = $1
  FOR UPDATE`;

export async function lockResumeCueMessageIdWith(
  client: PoolClient,
  approvalId: string,
): Promise<number | null> {
  const res = await client.query(LOCK_RESUME_CUE_MESSAGE_SQL, [approvalId]);
  const row = res.rows[0] as
    | { resume_cue_message_id: number | string | null }
    | undefined;
  if (row === undefined || row.resume_cue_message_id === null) return null;
  return Number(row.resume_cue_message_id);
}

/**
 * Bind the `approval_resolved` cue row to the approval it explains, in the same
 * transaction as the transcript INSERT that produced `cueMessageId`. Pairing
 * the two writes is what makes the cue exactly-once per approval: either both
 * land or neither does, so a retry after a crash never appends a second copy
 * and never records a cue that is not in the transcript.
 */
const ATTACH_RESUME_CUE_MESSAGE_SQL = `UPDATE approval_intents
   SET resume_cue_message_id = $2
 WHERE approval_id = $1`;

export async function attachResumeCueMessageWith(
  client: PoolClient,
  approvalId: string,
  cueMessageId: number,
): Promise<void> {
  await client.query(ATTACH_RESUME_CUE_MESSAGE_SQL, [approvalId, cueMessageId]);
}

/**
 * `dispatching -> indeterminate`, in the caller's locked transaction. The
 * caller has already proven (under `SELECT ... FOR UPDATE` on this row) that
 * the dispatch is old AND that no unexpired runner lease exists. The CAS
 * predicate is the last line of defence against flipping a dispatch that a
 * concurrent writer just completed.
 */
const CAS_MARK_INDETERMINATE_SQL = `UPDATE approval_intents
   SET execution_status = 'indeterminate'
 WHERE approval_id      = $1
   AND execution_status = 'dispatching'
 RETURNING approval_id`;

export async function casMarkIndeterminateWith(
  client: PoolClient,
  approvalId: string,
): Promise<boolean> {
  const res = await client.query(CAS_MARK_INDETERMINATE_SQL, [approvalId]);
  return (res.rowCount ?? 0) > 0;
}

// ── Reads for the reconciler + deferred resume ──────────────────────────

/**
 * Narrow projection for the lifecycle paths. Deliberately NOT `ApprovalIntent`:
 * the reconciler and the end-of-turn hook care only about the state machine,
 * and pulling `preview_json` / `policy_json` into a scan that runs every five
 * minutes would drag the JSONB payloads along for no reader.
 */
export interface ApprovalLifecycleRow {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly toolCallId: string | null;
  readonly decision: ApprovalDecision | null;
  readonly executionStatus: ApprovalExecutionStatus;
  readonly dispatchStartedAt: string | null;
  readonly resultMessageId: number | null;
  /** Completion marker — set only once a resumed turn has durably finished. */
  readonly resumeConsumedAt: string | null;
}

const LIFECYCLE_COLUMNS =
  "approval_id, session_id, mission_run_id, tool_call_id, decision, " +
  "execution_status, dispatch_started_at, result_message_id, resume_consumed_at";

function mapLifecycleRow(r: Record<string, unknown>): ApprovalLifecycleRow {
  return {
    approvalId: r.approval_id as string,
    sessionId: r.session_id as string,
    missionRunId: r.mission_run_id as string | null,
    toolCallId: r.tool_call_id as string | null,
    decision: r.decision as ApprovalDecision | null,
    executionStatus:
      (r.execution_status as ApprovalExecutionStatus) ?? "not_started",
    dispatchStartedAt: toIsoOrNull(
      r.dispatch_started_at as string | Date | null,
    ),
    resultMessageId:
      r.result_message_id === null || r.result_message_id === undefined
        ? null
        : Number(r.result_message_id),
    resumeConsumedAt: toIsoOrNull(r.resume_consumed_at as string | Date | null),
  };
}

/**
 * The two shapes an incomplete approval lifecycle can take. ONE predicate,
 * shared by the reconciler scan and the per-session deferred-resume lookup, so
 * the fast in-process paths can never be blind to a state the five-minute
 * sweep would have fixed:
 *
 *   1. DECIDED BUT UNDISPATCHED — approved, `not_started`. The tool provably
 *      never ran (the dispatch CAS is the only exit), so it still has to run.
 *      This is what a busy session lease at decision time leaves behind, i.e.
 *      the ordinary "user approved while a turn was in flight" case.
 *   2. DISPATCHED BUT UNRESUMED — a tool result exists and no resumed turn has
 *      COMPLETED for it. Only the agent wake is missing.
 *
 * Shape 2 keys off completion, never off a resume having started. An attempt
 * that claimed the lease and then died mid-turn is still an unresumed
 * approval, and it stays in this set until a turn actually finishes; the
 * runner lease, not this predicate, is what stops two attempts from
 * overlapping.
 *
 * `dispatching` rows are in scope for the reconciler only: deciding whether
 * one is abandoned needs the row lock + lease check that only the reconciler
 * performs, and no fast path may ever guess at it.
 *
 * Deliberately NOT filtered by age. Staleness is decided per row, under a row
 * lock, against the live runner lease — a fixed age alone would convert a
 * healthy heartbeated dispatch into a false alarm.
 */
const RESUMABLE_SHAPES_PREDICATE = `(
        (decision = 'approved' AND execution_status = 'not_started')
     OR (result_message_id IS NOT NULL AND resume_consumed_at IS NULL)
      )`;

/**
 * Fairness ordering for the two fixed-size lifecycle scans below.
 *
 * Both take a bounded batch in age order (50 rows for the reconciler, 10 per
 * session for the fast worker). A row whose mission run has left
 * `APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES` cannot be resumed on this pass, and
 * no amount of retrying changes that — only the run moving. Under a pure
 * `decided_at ASC` order such rows therefore sit at the head of every batch for
 * as long as they exist, and an accumulation of them crowds out newer approvals
 * that COULD be resumed. This expression sorts them last instead.
 *
 * DEPRIORITISED, NEVER DROPPED. Most blocked runs are recoverable — an operator
 * retries a `paused_error` run and the approval becomes claimable again — so the
 * rows stay in the set and simply yield to work that can make progress. Nothing
 * here is a terminal verdict; see the seam in
 * `engine/core/approval-runtime/lifecycle-actions.ts` for what is still owed.
 *
 * `dispatching` rows keep full priority. The only thing they need is the
 * reconciler's `indeterminate` verdict, which is decided from the row lock and
 * the live runner lease and never consults the run status — delaying an
 * unprovable money-path outcome would be the wrong thing to trade for fairness.
 *
 * A busy lease is deliberately NOT part of this. Leases carry a TTL, so lease
 * contention is transient by construction; the run status is the only durable
 * reason a claim keeps failing.
 */
function resumeBlockedOrderExpr(statusParam: string): string {
  return `(
            approval_intents.mission_run_id   IS NOT NULL
        AND approval_intents.execution_status <> 'dispatching'
        AND NOT EXISTS (
              SELECT 1
                FROM mission_runs mr
               WHERE mr.id     = approval_intents.mission_run_id
                 AND mr.status = ANY(${statusParam}::text[])
            )
          )`;
}

/**
 * Reconciler scan — every decided approval whose lifecycle is still
 * incomplete, including the `dispatching` rows only this pass may judge.
 */
export async function getIncompleteLifecycle(
  limit = 50,
): Promise<ApprovalLifecycleRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${LIFECYCLE_COLUMNS}
       FROM approval_intents
      WHERE decision IS NOT NULL
        AND (
              (decision = 'approved' AND execution_status = 'dispatching')
           OR ${RESUMABLE_SHAPES_PREDICATE}
            )
      ORDER BY ${resumeBlockedOrderExpr("$2")} ASC,
               decided_at ASC NULLS FIRST
      LIMIT $1`,
    [limit, [...APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES]],
  );
  return rows.map(mapLifecycleRow);
}

/**
 * Everything the fast deferred-resume worker may act on for ONE session — the
 * in-process backoff ladder and the end-of-turn hook.
 *
 * Both resumable shapes are returned. Returning only "dispatched but
 * unresumed" was the defect that left the owner's primary requirement half
 * fixed: on a busy lease the tool never dispatched, so no result row exists,
 * so the backoff retries and the end-of-turn hook both found nothing and the
 * approval sat until the five-minute sweep.
 *
 * `resumed_at` is intentionally absent from the predicate; it records
 * attempts, and an attempt is not a consumption.
 *
 * One session can own several mission runs, so a row blocked on ITS run's
 * status says nothing about the next row — hence the same fairness ordering as
 * the reconciler scan.
 */
export async function getPendingLifecycleForSession(
  sessionId: string,
  limit = 10,
): Promise<ApprovalLifecycleRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${LIFECYCLE_COLUMNS}
       FROM approval_intents
      WHERE session_id    = $1
        AND decision IS NOT NULL
        AND ${RESUMABLE_SHAPES_PREDICATE}
      ORDER BY ${resumeBlockedOrderExpr("$3")} ASC,
               decided_at ASC NULLS FIRST
      LIMIT $2`,
    [sessionId, limit, [...APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES]],
  );
  return rows.map(mapLifecycleRow);
}

/**
 * Lock one intent row for the reconciler's decision transaction. The lock is
 * what lets the caller read the row, read the runner lease, and CAS the
 * transition as one indivisible step.
 */
export async function lockLifecycleRowWith(
  client: PoolClient,
  approvalId: string,
): Promise<ApprovalLifecycleRow | null> {
  const res = await client.query(
    `SELECT ${LIFECYCLE_COLUMNS}
       FROM approval_intents
      WHERE approval_id = $1
      FOR UPDATE`,
    [approvalId],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row === undefined ? null : mapLifecycleRow(row);
}
