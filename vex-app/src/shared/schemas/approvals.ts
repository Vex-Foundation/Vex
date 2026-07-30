/**
 * Approvals schemas — pending queue + history summaries.
 *
 * Renderer NEVER receives the raw `approval_queue.tool_call` /
 * `pending_context` JSONB. The main-side mapper in
 * `vex-app/src/main/database/approvals-db.ts` is the single place
 * where those JSONB blobs get reduced to allow-listed DTO fields:
 *   - `toolName` (best-effort `namespace:command`),
 *   - `toolCallId`,
 *   - `permissionAtEnqueue`,
 *   - `reasoningPreview` (first 200 chars of `reasoning`).
 *
 * Approve/reject are wired (puzzle 05 phase 3): a durable decision tx
 * plus a background runtime continuation. Non-actionable states surface
 * the `approvals.*` decision codes (`expired`, `already_resolved`,
 * `run_terminated`, `dispatch_failed`, `policy_drift_blocked`).
 *
 * Field names match the canonical refs vocabulary in
 * `BUG-REPORTING.md §3` (`sessionId`, `toolCallId`, `toolName`).
 */

import { z } from "zod";

export const APPROVAL_REASONING_PREVIEW_MAX = 200;
export const APPROVAL_HISTORY_DEFAULT_LIMIT = 20;
export const APPROVAL_HISTORY_MAX_LIMIT = 100;

/** Mirrors the `approval_queue.status` CHECK from migration 001. */
export const approvalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** Mirrors the `approval_queue.permission_at_enqueue` CHECK. */
export const approvalPermissionSchema = z.enum(["restricted", "full"]);
export type ApprovalPermission = z.infer<typeof approvalPermissionSchema>;

/**
 * Mirrors the `approval_intents.action_kind` CHECK from migration 024.
 * Same 7 variants as `src/vex-agent/tools/taxonomy.ts::ACTION_KINDS`; kept
 * as a separate Zod schema here so the renderer schema layer does not
 * depend on the agent runtime. Adding a variant requires updating both
 * sides — `protocol-taxonomy.test.ts` + `registry-taxonomy.test.ts` pin
 * the agent side; consumers of this Zod schema pin the renderer side.
 */
export const approvalActionKindSchema = z.enum([
  "read",
  "local_write",
  "schedule",
  "approval_prepare",
  "user_wallet_broadcast",
  "external_post",
  "destructive",
]);
export type ApprovalActionKind = z.infer<typeof approvalActionKindSchema>;

/** Mirrors `approval_intents.risk_level` CHECK from migration 024. */
export const approvalRiskLevelSchema = z.enum([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);
export type ApprovalRiskLevel = z.infer<typeof approvalRiskLevelSchema>;

/**
 * Mirrors `approval_intents.decision` CHECK from migration 024. Phase 2 only
 * writes the intent row at enqueue (decision is NULL until phase 3 runtime
 * lands); `rejected_stop` is included now because phase 3 reject-and-stop UI
 * will gate against the same CHECK.
 */
export const approvalDecisionSchema = z.enum([
  "approved",
  "rejected",
  "rejected_stop",
]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/**
 * Mirrors `approval_intents.execution_status` CHECK from migration 024, widened
 * by migration 056.
 *
 * `indeterminate` is the honest terminal state for an approved dispatch whose
 * outcome could not be proven — the runtime stopped between taking the dispatch
 * slot and recording the result. It MUST be listed here: this schema is
 * `.strict()`-adjacent and validated on both sides of the IPC boundary, so an
 * unlisted value would make the approval unreadable by the renderer rather than
 * merely unfamiliar.
 */
export const approvalExecutionStatusSchema = z.enum([
  "not_started",
  "dispatching",
  "succeeded",
  "failed",
  "indeterminate",
]);
export type ApprovalExecutionStatus = z.infer<
  typeof approvalExecutionStatusSchema
>;

/**
 * Renderer-safe preview projection from `approval_intents.preview_json`.
 * The main-side mapper allow-lists keys via the same defensive style as
 * `extractToolName`: never recurses, never returns raw blobs. Values are
 * coerced to JSON-safe scalars (strings ≤200 chars, numbers, booleans, null).
 * Strict schema means an unexpected shape at the boundary is rejected.
 */
export const approvalPreviewSchema = z
  .object({
    toolName: z.string(),
    namespace: z.string().optional(),
    criticalArgs: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
  })
  .strict();
export type ApprovalPreview = z.infer<typeof approvalPreviewSchema>;

export const approvalSummaryDtoSchema = z
  .object({
    id: z.string().min(1),
    /**
     * `approval_queue.session_id` is nullable in the DB (the engine can
     * enqueue session-less approvals from non-chat sources). UI may
     * filter on this; the renderer surfaces the value as-is.
     */
    sessionId: z.string().uuid().nullable(),
    toolCallId: z.string().nullable(),
    /**
     * Best-effort tool identifier extracted from `tool_call` JSONB
     * (preferred: `namespace:command` when both are strings; fallback
     * `command`, `name`, finally `"unknown"`). Refined when tool
     * registry metadata is wired in puzzle 05.
     */
    toolName: z.string().nullable(),
    status: approvalStatusSchema,
    permissionAtEnqueue: approvalPermissionSchema,
    createdAt: z.string().datetime({ offset: true }),
    resolvedAt: z.string().datetime({ offset: true }).nullable(),
    /** First 200 chars of `approval_queue.reasoning`, no JSONB leakage. */
    reasoningPreview: z.string().max(APPROVAL_REASONING_PREVIEW_MAX),
    /**
     * Puzzle 5 phase 2 — `approval_intents` companion fields. Populated only
     * when an intent row exists for this approval (back-compat with rows
     * predating migration 024); the mapper LEFT JOIN tolerates the absence.
     * Phase 3 wires the `decision` / `decisionReason` / `executionStatus`
     * lifecycle; phase 2 always exposes those as null.
     */
    actionKind: approvalActionKindSchema.nullable(),
    riskLevel: approvalRiskLevelSchema.nullable(),
    preview: approvalPreviewSchema.nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    decision: approvalDecisionSchema.nullable(),
    decisionReason: z.string().nullable(),
    executionStatus: approvalExecutionStatusSchema.nullable(),
  })
  .strict();
export type ApprovalSummaryDto = z.infer<typeof approvalSummaryDtoSchema>;

/**
 * App-wide pending-approvals DTO. Extends the FULL sanitized summary (so the
 * global inbox reuses `ApprovalCard` verbatim — dropping riskLevel/actionKind/
 * preview would let a destructive action skip the two-step high-risk confirm)
 * and adds the joined session display name. `sessionTitle` is nullable: the
 * main-side query resolves `COALESCE(title, initial_goal)` and leaves null for
 * session-less approvals or deleted sessions, which the renderer labels with a
 * fallback. `.strict()` keeps the raw `tool_call` JSONB (or any unexpected key)
 * from riding along.
 */
export const approvalPendingGlobalDtoSchema = approvalSummaryDtoSchema
  .extend({
    sessionTitle: z.string().nullable(),
  })
  .strict();
export type ApprovalPendingGlobalDto = z.infer<
  typeof approvalPendingGlobalDtoSchema
>;

/**
 * Input for `approvals.listPendingAll` — the app-wide read takes no arguments.
 * A strict empty object rejects any smuggled payload at both the preload gate
 * and the main-side envelope parse.
 */
export const approvalListPendingAllInputSchema = z.object({}).strict();
export type ApprovalListPendingAllInput = z.infer<
  typeof approvalListPendingAllInputSchema
>;

export const approvalListPendingInputSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();
export type ApprovalListPendingInput = z.infer<
  typeof approvalListPendingInputSchema
>;

export const approvalGetInputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();
export type ApprovalGetInput = z.infer<typeof approvalGetInputSchema>;

export const approvalGetHistoryInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(APPROVAL_HISTORY_MAX_LIMIT)
      .default(APPROVAL_HISTORY_DEFAULT_LIMIT),
  })
  .strict();
export type ApprovalGetHistoryInput = z.infer<
  typeof approvalGetHistoryInputSchema
>;

/** Upper bound on the user-authored reject reason (engine mirrors this). */
export const APPROVAL_REJECT_REASON_MAX = 500;

/**
 * Input for `approvals.approve` / `approvals.reject`.
 *
 * `reason` is optional and only consumed by reject — the engine's
 * `prepareReject` already accepted one, but nothing ever passed it, so every
 * rejection reached the model as "No reason provided".
 *
 * It is UNTRUSTED user text that ends up as model-visible transcript content,
 * so it is trimmed and hard-bounded here (validated at the preload gate AND
 * again in main, because `.strict()` schemas guard both) and additionally
 * stripped of control characters engine-side before it is rendered — a reason
 * must never be able to forge lines that look like engine control banners.
 */
export const approvalActionInputSchema = z
  .object({
    id: z.string().min(1),
    reason: z.string().trim().max(APPROVAL_REJECT_REASON_MAX).optional(),
  })
  .strict();
export type ApprovalActionInput = z.infer<typeof approvalActionInputSchema>;

/**
 * Result contract for `approvals.approve`/`approvals.reject`.
 *
 * Puzzle 5 phase 3 fills the body. Field semantics:
 *   - `status`            — final `approval_queue.status` after the IPC call.
 *   - `resolvedAt`        — when the queue row was resolved (ISO-8601).
 *   - `runtimeOutcome`    — what actually happened to the agent, never a guess:
 *                           `'resumed'`       a continuation was claimed and
 *                                             the agent is being re-invoked
 *                                             (mission run OR chat session);
 *                           `'deferred_busy'` another runner holds the session
 *                                             lease, so the wake is queued and
 *                                             will be delivered by a retry, the
 *                                             end-of-turn hook, or the
 *                                             reconciler;
 *                           `'stopped'`       nothing further will run (an
 *                                             idempotent replay of an already
 *                                             resolved decision);
 *                           `'unavailable'`   reserved for the old phase-1
 *                                             fail-closed path.
 *   - `executionStatus`   — tool dispatch outcome (`'succeeded'`/`'failed'`
 *                           for approve; null for reject). Independent of
 *                           `runtimeOutcome`: a mission run can resume even
 *                           after a failed dispatch (agent sees the error
 *                           in transcript and decides next).
 *   - `missionRunId`      — set when a mission run was involved; null for
 *                           chat-session approvals.
 *   - `cached`            — `true` when the response is an idempotent
 *                           replay of a prior decision (no new dispatch).
 *   - `message`           — short human-readable summary for the UI toast.
 */
export const approvalActionResultSchema = z
  .object({
    id: z.string().min(1),
    status: approvalStatusSchema,
    resolvedAt: z.string().datetime({ offset: true }).nullable(),
    runtimeOutcome: z.enum([
      "resumed",
      "deferred_busy",
      "stopped",
      "unavailable",
    ]),
    executionStatus: approvalExecutionStatusSchema.nullable(),
    missionRunId: z.string().nullable(),
    cached: z.boolean(),
    message: z.string(),
  })
  .strict();
export type ApprovalActionResult = z.infer<typeof approvalActionResultSchema>;
