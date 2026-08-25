/**
 * Approval intents repo — policy-layer companion to `approval_queue`.
 *
 * Plan: agents_dm/plan-integration/05-approvals-wallet-policy.md §"Approval DB model".
 * Migration: `src/vex-agent/db/migrations/024_approval_intents.sql`.
 *
 * Puzzle 5 phase 2 wrote the snapshot columns at enqueue time (`action_kind`,
 * `risk_level`, `preview_json`, `policy_json`, `mission_run_id`, `tool_call_id`).
 * Phase 3 wires the runtime: `expires_at` is stamped at enqueue
 * (NOT at approve — corrects the phase-2 misalignment comment), and the
 * approve/reject/expire path populates `decision`, `decision_reason`,
 * `decided_at`, `execution_status`, `execution_result_hash`, and
 * `idempotency_key` via the CAS helpers below.
 *
 * Transactional contracts:
 *   - `createWith(client, ...)`               — INSERT at enqueue tx.
 *   - `markDecisionWith(client, ...)`         — CAS UPDATE; only flips a row
 *                                               whose `decision IS NULL`.
 *   - `markExecutionStatusWith(client, ...)`  — in-tx variant of below.
 *   - `markExecutionStatus(...)`              — non-tx; called AFTER the
 *                                               decision tx commits so audit
 *                                               drift can't roll back the
 *                                               decision itself.
 *   - `getExpired(now)`                       — non-tx scan used by the
 *                                               scheduled TTL sweep.
 *
 * The post-decision EXECUTION lifecycle (migration 056: dispatch CAS, atomic
 * result commit, resume consumption, reconciler reads) lives in
 * `./approval-intents/lifecycle.ts` and is re-exported below — one table, one
 * public surface, two reasons to change.
 *
 * All scalar columns expose ISO-8601 strings; `pg` returns `Date` for
 * `TIMESTAMPTZ` so `toIso{,OrNull}` (`./approval-intents/row-mapping.ts`)
 * normalise before the value crosses the repo interface.
 */

import type { ClientBase, PoolClient } from "pg";
import type { ActionKind } from "../../tools/taxonomy.js";
import type { RiskLevel } from "../../tools/risk-level.js";
import type {
  IntentPreview,
  PolicySnapshot,
} from "../../engine/core/approval-intent-preview.js";
import { query, queryOne, execute } from "../client.js";
import { jsonb } from "../params.js";
import { toIso, toIsoOrNull } from "./approval-intents/row-mapping.js";

/**
 * Execution lifecycle (migration 056) — dispatch CAS, atomic result commit,
 * resume consumption, and the reconciler/deferred-resume reads. Re-exported by
 * name so `import * as approvalIntentsRepo` remains the single public surface
 * for this table; the split exists because the lifecycle has a different reason
 * to change than the decision CAS above it.
 */
export {
  casMarkDispatchingWith,
  commitExecutionResultWith,
  attachResultMessageWith,
  markResumeAttempted,
  casMarkResumeConsumed,
  hasResumeCompleted,
  lockResumeCueMessageIdWith,
  attachResumeCueMessageWith,
  casMarkIndeterminateWith,
  getIncompleteLifecycle,
  getPendingLifecycleForSession,
  lockLifecycleRowWith,
  type ApprovalLifecycleRow,
} from "./approval-intents/lifecycle.js";

/**
 * Studio settlement writes (migration 086). Same table, third reason to
 * change: these are the only writes that store a whole tool result on the row
 * instead of pointing at a transcript message, because a Studio call has no
 * transcript to point at.
 */
export {
  casClaimStudioDispatchSlotWith,
  casRefuseStudioBeforeDispatchWith,
  casMarkIndeterminateWithSettlementWith,
  commitStudioSettlementWith,
  getStudioSettlementByApprovalId,
  listDispatchingStudioApprovals,
  listUnstartedStudioApprovals,
  type DispatchingStudioApproval,
  type DispatchingStudioCursor,
  type StudioSettlementRow,
} from "./approval-intents/studio-settlement.js";

export type ApprovalDecision = "approved" | "rejected" | "rejected_stop";

/**
 * WHICH SURFACE created the intent (migration 086). `agent` is the default and
 * the value every pre-086 row carries; `studio_mcp` is a call from an external
 * coding agent through the Vex Studio MCP surface.
 *
 * It is not a second state axis. It selects which SIDE EFFECTS a decision
 * runs: an agent row appends a transcript tool result and resumes a turn, a
 * Studio row writes a settlement and releases a blocked MCP call. The decision
 * and execution state machines are identical for both.
 */
export type ApprovalOrigin = "agent" | "studio_mcp";

/**
 * The six causes that terminally refuse a PENDING Studio intent. Written
 * together with `decision = 'rejected'`; `decision_reason` carries the human
 * sentence, this carries the machine fact.
 *
 * Kept as its own type because `refuse.ts` owns a sentence for EXACTLY these
 * six and must stay exhaustive over them: the post-decision causes below never
 * travel through that primitive.
 */
export type StudioPendingRefusalReason =
  | "lock"
  | "disconnect"
  | "cancelled"
  | "project_deleted"
  | "scope_changed"
  | "vex_quit";

/**
 * The causes recorded AFTER a human approved the intent.
 *
 *   `stopped`                the operator-stop gate fired in the pre-dispatch
 *                            transaction;
 *   `generation_superseded`  Vex was locked or unlocked between the enqueue and
 *                            the dispatch, or the dispatch preflight could not
 *                            prove the fence had moved;
 *   `scope_unavailable`      the project scope the dispatch needed could not be
 *                            established;
 *   `expired`                nobody decided before the intent's own TTL.
 *
 * Each is written together with a TERMINAL state (`execution_status = 'failed'`
 * for the first three, `decision = 'rejected'` for the expiry), so a row can
 * never carry one of them and still be dispatchable.
 */
export type StudioPostDecisionRefusalReason =
  | "stopped"
  | "generation_superseded"
  | "scope_unavailable"
  | "expired";

export type ApprovalRefusalReason =
  | StudioPendingRefusalReason
  | StudioPostDecisionRefusalReason;
/**
 * `indeterminate` (migration 056) is the honest terminal state for an approved
 * dispatch whose outcome cannot be proven — the process died between the
 * `dispatching` mark and the result commit. Recovery must NEVER re-dispatch an
 * approved money-path tool, so an unprovable outcome is reported as unknown
 * rather than guessed as success or failure.
 */
export type ApprovalExecutionStatus =
  | "not_started"
  | "dispatching"
  | "succeeded"
  | "failed"
  | "indeterminate";

export interface ApprovalIntent {
  approvalId: string;
  sessionId: string;
  missionRunId: string | null;
  toolCallId: string | null;
  actionKind: ActionKind;
  riskLevel: RiskLevel;
  previewJson: Record<string, unknown>;
  policyJson: Record<string, unknown>;
  expiresAt: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  decidedAt: string | null;
  decision: ApprovalDecision | null;
  decisionReason: string | null;
  executionStatus: ApprovalExecutionStatus;
  executionResultHash: string | null;
}

/**
 * `previewJson` / `policyJson` accept either the structured builder output
 * (`IntentPreview` / `PolicySnapshot` from `approval-intent-preview.ts`) or a
 * raw `Record<string, unknown>` so future callers can pass through pre-built
 * JSONB payloads without an `as unknown as` cast at the call site. Both shapes
 * round-trip through `jsonb()` unchanged. Codex puzzle-5 phase-3 cleanup.
 */
export interface CreateIntentInput {
  approvalId: string;
  sessionId: string;
  missionRunId: string | null;
  toolCallId: string | null;
  actionKind: ActionKind;
  riskLevel: RiskLevel;
  previewJson: IntentPreview | Record<string, unknown>;
  policyJson: PolicySnapshot | Record<string, unknown>;
  /**
   * Phase 3 stamps this at enqueue (NOT at approve — see file header) so the
   * approve gate and the scheduled sweep can both rely on a DB-visible TTL.
   * Callers without a TTL pass `null`.
   */
  expiresAt?: string | null;
  /**
   * Migration 086 - Studio provenance. `agent` (the default) writes exactly the
   * row shape every pre-086 caller wrote; the four Studio fields below are NULL
   * for it, and the CHECK plus the column default keep an omitted value honest.
   */
  origin?: ApprovalOrigin;
  /** Studio only - the project whose scope authorized the call. */
  projectId?: string | null;
  /** Studio only - the `projects.scope_version` the call was admitted under. */
  scopeVersionAtEnqueue?: number | null;
  /** Studio only - sha256 of the canonical envelope stored on the queue row. */
  requestDigest?: string | null;
  /**
   * Studio only - the durable dispatch generation read in the SAME transaction
   * as this insert. The dispatch-slot claim requires it to still be current, so
   * a claim after a lock or unlock advance matches zero rows.
   */
  dispatchGenerationAtEnqueue?: string | null;
  /**
   * Phase 3 stamps this at approve via `markDecisionWith` (defense-in-depth
   * audit for the dedup gate; `idx_approval_intents_idempotency` UNIQUE
   * partial index guards cross-approval reuse). Phase 2 inserts pass `null`.
   */
  idempotencyKey?: string | null;
}

const INSERT_INTENT_SQL = `INSERT INTO approval_intents (
  approval_id, session_id, mission_run_id, tool_call_id,
  action_kind, risk_level, preview_json, policy_json,
  expires_at, idempotency_key,
  origin, project_id, scope_version_at_enqueue, request_digest,
  dispatch_generation_at_enqueue
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
          $11, $12, $13, $14, $15)`;

function toCreateParams(input: CreateIntentInput): unknown[] {
  return [
    input.approvalId,
    input.sessionId,
    input.missionRunId,
    input.toolCallId,
    input.actionKind,
    input.riskLevel,
    jsonb(input.previewJson),
    jsonb(input.policyJson),
    input.expiresAt ?? null,
    input.idempotencyKey ?? null,
    input.origin ?? "agent",
    input.projectId ?? null,
    input.scopeVersionAtEnqueue ?? null,
    input.requestDigest ?? null,
    input.dispatchGenerationAtEnqueue ?? null,
  ];
}

/**
 * Transactional INSERT — required for the puzzle-5 phase-2 enqueue site
 * (queue+intent+mission status updated together via `withTransaction`).
 * Caller is responsible for `BEGIN`/`COMMIT`; pass the `PoolClient`
 * yielded by `withTransaction(fn)`.
 */
export async function createWith(
  client: PoolClient,
  input: CreateIntentInput,
): Promise<void> {
  await client.query(INSERT_INTENT_SQL, toCreateParams(input));
}

/**
 * Decision write — CAS-guarded `UPDATE` that only fires when `decision IS
 * NULL`. Returns `true` if this call flipped the row, `false` if another
 * writer (concurrent approve, sweep, expire) had already set a decision.
 *
 * Caller MUST run inside the same `withTransaction(fn)` that lock-acquired
 * the intent row via `SELECT ... FOR UPDATE` — without that lock the CAS is
 * still safe (RETURNING discriminates) but the surrounding queue/intent
 * snapshot can drift, which the phase-3 prepare paths require to hold.
 */
export interface MarkDecisionInput {
  approvalId: string;
  kind: ApprovalDecision;
  reason?: string | null;
  idempotencyKey?: string | null;
  /**
   * Migration 086 - the machine cause of a TERMINAL REFUSAL of a pending
   * Studio intent, written in the same CAS as the decision so a refused row can
   * never exist without the reason that refused it. Omitted (NULL) for every
   * agent decision and for an ordinary user Reject.
   */
  refusalReason?: ApprovalRefusalReason | null;
}

const MARK_DECISION_SQL = `UPDATE approval_intents
   SET decision        = $2,
       decided_at      = NOW(),
       decision_reason = $3,
       idempotency_key = $4,
       refusal_reason  = $5
 WHERE approval_id = $1
   AND decision IS NULL
 RETURNING approval_id`;

/**
 * `ClientBase` for the same reason as `approvalsRepo.rejectWith`: the Studio
 * refusal owners write this CAS from a main-process `pg.Client` transaction.
 * `PoolClient` extends it, so every existing caller is unchanged.
 */
export async function markDecisionWith(
  client: ClientBase,
  input: MarkDecisionInput,
): Promise<boolean> {
  const res = await client.query(MARK_DECISION_SQL, [
    input.approvalId,
    input.kind,
    input.reason ?? null,
    input.idempotencyKey ?? null,
    input.refusalReason ?? null,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Execution-status write — UPDATE that always overwrites the column. Audit
 * eventual consistency: if the post-dispatch write fails the IPC caller can
 * still tell the user "your decision was applied" because the queue+intent
 * decision tx already committed. The `transition` table the runtime walks
 * through is `not_started → dispatching → (succeeded|failed)`; a `failed`
 * row never transitions back so the audit trail is monotonic.
 */
const MARK_EXECUTION_STATUS_SQL = `UPDATE approval_intents
   SET execution_status      = $2,
       execution_result_hash = COALESCE($3, execution_result_hash)
 WHERE approval_id = $1`;

export async function markExecutionStatusWith(
  client: PoolClient,
  approvalId: string,
  status: ApprovalExecutionStatus,
  resultHash?: string | null,
): Promise<void> {
  await client.query(MARK_EXECUTION_STATUS_SQL, [
    approvalId,
    status,
    resultHash ?? null,
  ]);
}

export async function markExecutionStatus(
  approvalId: string,
  status: ApprovalExecutionStatus,
  resultHash?: string | null,
): Promise<void> {
  await execute(MARK_EXECUTION_STATUS_SQL, [
    approvalId,
    status,
    resultHash ?? null,
  ]);
}

const SELECT_COLUMNS =
  "approval_id, session_id, mission_run_id, tool_call_id, " +
  "action_kind, risk_level, preview_json, policy_json, " +
  "expires_at, idempotency_key, created_at, decided_at, " +
  "decision, decision_reason, execution_status, execution_result_hash";

function mapRow(r: Record<string, unknown>): ApprovalIntent {
  return {
    approvalId: r.approval_id as string,
    sessionId: r.session_id as string,
    missionRunId: r.mission_run_id as string | null,
    toolCallId: r.tool_call_id as string | null,
    actionKind: r.action_kind as ActionKind,
    riskLevel: r.risk_level as RiskLevel,
    previewJson: (r.preview_json as Record<string, unknown>) ?? {},
    policyJson: (r.policy_json as Record<string, unknown>) ?? {},
    expiresAt: toIsoOrNull(r.expires_at as string | Date | null),
    idempotencyKey: r.idempotency_key as string | null,
    createdAt: toIso(r.created_at as string | Date),
    decidedAt: toIsoOrNull(r.decided_at as string | Date | null),
    decision: r.decision as ApprovalDecision | null,
    decisionReason: r.decision_reason as string | null,
    executionStatus:
      (r.execution_status as ApprovalExecutionStatus) ?? "not_started",
    executionResultHash: r.execution_result_hash as string | null,
  };
}

export async function getByApprovalId(
  approvalId: string,
): Promise<ApprovalIntent | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM approval_intents WHERE approval_id = $1`,
    [approvalId],
  );
  return row ? mapRow(row) : null;
}

export async function getPendingForSession(
  sessionId: string,
): Promise<ApprovalIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT i.${SELECT_COLUMNS.replace(/, /g, ", i.")}
       FROM approval_intents i
       JOIN approval_queue q ON q.id = i.approval_id
      WHERE i.session_id = $1 AND q.status = 'pending'
      ORDER BY i.created_at ASC`,
    [sessionId],
  );
  return rows.map(mapRow);
}

/**
 * Lookup for the scheduled TTL sweep: only intents that BOTH still have a
 * pending queue row AND have an `expires_at` strictly less than `now` AND
 * have not yet been decided. The JOIN on `approval_queue.status = 'pending'`
 * is the race-defense against a concurrent approve/reject having already
 * resolved the row (`expireApproval` would then see `decision != NULL` and
 * skip).
 *
 * Returned in `created_at` order so the oldest expired rows get processed
 * first — bounded by the caller's `LIMIT` to avoid a single-cycle stall.
 */
export async function getExpired(
  now: Date | string,
  limit = 50,
): Promise<ApprovalIntent[]> {
  const nowIso = typeof now === "string" ? now : now.toISOString();
  const rows = await query<Record<string, unknown>>(
    `SELECT i.${SELECT_COLUMNS.replace(/, /g, ", i.")}
       FROM approval_intents i
       JOIN approval_queue q ON q.id = i.approval_id
      WHERE i.expires_at IS NOT NULL
        AND i.expires_at < $1
        AND i.decision IS NULL
        AND q.status = 'pending'
      ORDER BY i.created_at ASC
      LIMIT $2`,
    [nowIso, limit],
  );
  return rows.map(mapRow);
}
