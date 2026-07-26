/**
 * Memory-inspector schemas — read-only window into the agent memory manager's
 * pipeline (memory-system S10): candidate buffer (`memory_candidates`),
 * decision audit (`memory_decisions`), and job queue (`memory_jobs` +
 * `memory_job_items`). Table names are engine-internal and never surface in
 * the DTOs.
 *
 * SANITIZATION doctrine — the DTOs deliberately EXCLUDE:
 *  - candidate narrative/provenance payloads: `content_md`, `source_refs`,
 *    `evidence_refs`, `outcome`, `content_hash`, all embedding columns,
 *    `session_id`, `conversation_id`, `proposed_by`, `retain_until`,
 *    `retrieval_until` — only short-form metadata leaves the main process;
 *  - decision internals: `evidence_refs` (immutable anchor snapshot),
 *    `decision_hash`;
 *  - job worker internals: `locked_by`, `locked_at`, `heartbeat_at`, and
 *    `last_error` / any lastErrorCode. `memory_jobs.last_error` is untrusted
 *    free TEXT (may quote provider/tool failures verbatim); a future slice may
 *    expose a finite vetted code allowlist instead — do NOT re-add raw
 *    `last_error` casually.
 *
 * READ-ONLY by doctrine: the memory lifecycle (consolidation, promotion,
 * reject/expire, reconcile) is exclusively owned by the agent's memory
 * manager — there is deliberately NO mutation surface here (S9).
 *
 * Every closed vocabulary is re-declared (shared/ must not import
 * `src/vex-agent`); each set mirrors the engine enum and is pinned by a mirror
 * test in `__tests__/memory-inspector.test.ts` — drift surfaces as a test
 * failure plus a boundary parse failure. `source` REUSES the shared
 * long-memory provenance enum (candidates share the `knowledge_entries`
 * source vocabulary).
 */

import { z } from "zod";
import { longMemorySourceSchema } from "./long-memory.js";

export const MEMORY_INSPECTOR_LIST_DEFAULT_LIMIT = 100;
export const MEMORY_INSPECTOR_LIST_MAX_LIMIT = 500;
export const MEMORY_INSPECTOR_RECENT_JOBS_DEFAULT_LIMIT = 20;
export const MEMORY_INSPECTOR_RECENT_JOBS_MAX_LIMIT = 100;

// ── Candidate vocabularies (memory/schema/memory-candidate-enums.ts) ──

/** Mirrors engine `CANDIDATE_STATUS`. */
export const MEMORY_CANDIDATE_STATUSES = [
  "pending",
  "promoted",
  "superseded",
  "merged",
  "rejected",
  "expired",
  "retained",
] as const;
export const memoryCandidateStatusSchema = z.enum(MEMORY_CANDIDATE_STATUSES);
export type MemoryCandidateStatusDto = z.infer<
  typeof memoryCandidateStatusSchema
>;

/** Mirrors engine `CANDIDATE_SENSITIVITY`. */
export const MEMORY_CANDIDATE_SENSITIVITIES = ["normal", "sensitive"] as const;
export const memoryCandidateSensitivitySchema = z.enum(
  MEMORY_CANDIDATE_SENSITIVITIES,
);
export type MemoryCandidateSensitivityDto = z.infer<
  typeof memoryCandidateSensitivitySchema
>;

/** Mirrors engine `CANDIDATE_EVIDENCE_STRENGTH`. */
export const MEMORY_CANDIDATE_EVIDENCE_STRENGTHS = [
  "none",
  "weak",
  "moderate",
  "strong",
] as const;
export const memoryCandidateEvidenceStrengthSchema = z.enum(
  MEMORY_CANDIDATE_EVIDENCE_STRENGTHS,
);
export type MemoryCandidateEvidenceStrengthDto = z.infer<
  typeof memoryCandidateEvidenceStrengthSchema
>;

/** Mirrors engine `CANDIDATE_RETRIEVAL_VISIBILITY`. */
export const MEMORY_CANDIDATE_RETRIEVAL_VISIBILITIES = [
  "not_consolidated",
  "suppressed",
] as const;
export const memoryCandidateRetrievalVisibilitySchema = z.enum(
  MEMORY_CANDIDATE_RETRIEVAL_VISIBILITIES,
);
export type MemoryCandidateRetrievalVisibilityDto = z.infer<
  typeof memoryCandidateRetrievalVisibilitySchema
>;

// ── Decision vocabularies (memory/schema/memory-decision-enums.ts) ──

/** Mirrors engine `MEMORY_DECISION_TYPE`. */
export const MEMORY_DECISION_TYPES = [
  "promote",
  "supersede",
  "merge",
  "retain",
  "reject",
  "expire",
  "reconcile",
] as const;
export const memoryDecisionTypeSchema = z.enum(MEMORY_DECISION_TYPES);
export type MemoryDecisionTypeDto = z.infer<typeof memoryDecisionTypeSchema>;

/** Mirrors engine `MEMORY_DECISION_REJECT_REASON`. */
export const MEMORY_DECISION_REJECT_REASONS = [
  "secret_or_live_state",
  "low_confidence",
  "duplicate",
  "insufficient_evidence",
  "superseded_by_existing",
  "expired_ttl",
  "policy",
] as const;
export const memoryDecisionRejectReasonSchema = z.enum(
  MEMORY_DECISION_REJECT_REASONS,
);
export type MemoryDecisionRejectReasonDto = z.infer<
  typeof memoryDecisionRejectReasonSchema
>;

/** Mirrors engine `MEMORY_DECISION_ACTOR`. */
export const MEMORY_DECISION_ACTORS = ["manager", "system"] as const;
export const memoryDecisionActorSchema = z.enum(MEMORY_DECISION_ACTORS);
export type MemoryDecisionActorDto = z.infer<typeof memoryDecisionActorSchema>;

// ── Job vocabularies (memory/schema/memory-job-enums.ts) ──

/**
 * Mirrors engine `MEMORY_JOB_STATUS`. `retired` (Agent Scan migration 044) is
 * a terminal value stamped ONLY on `reconcile` jobs once the async reconcile
 * machinery was removed — read-only doctrine here too, so this inspector just
 * displays it (job lists + the queue counter), never revives it.
 */
export const MEMORY_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "permanently_failed",
  "retired",
] as const;
export const memoryJobStatusSchema = z.enum(MEMORY_JOB_STATUSES);
export type MemoryJobStatusDto = z.infer<typeof memoryJobStatusSchema>;

/** Mirrors engine `MEMORY_JOB_KIND`. */
export const MEMORY_JOB_KINDS = ["consolidate", "reconcile"] as const;
export const memoryJobKindSchema = z.enum(MEMORY_JOB_KINDS);
export type MemoryJobKindDto = z.infer<typeof memoryJobKindSchema>;

// ── Inputs ──────────────────────────────────────────────────────

/**
 * Input for `memoryInspector.listCandidates`. `status` omitted = all
 * statuses. `limit` is bounded — never a caller-controlled unbounded scan.
 */
export const memoryInspectorListCandidatesInputSchema = z
  .object({
    status: memoryCandidateStatusSchema.optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(MEMORY_INSPECTOR_LIST_MAX_LIMIT)
      .default(MEMORY_INSPECTOR_LIST_DEFAULT_LIMIT),
  })
  .strict();
export type MemoryInspectorListCandidatesInput = z.infer<
  typeof memoryInspectorListCandidatesInputSchema
>;

/**
 * Input for `memoryInspector.listDecisions`. Optional candidate anchor +
 * decision-type filters; bounded limit.
 */
export const memoryInspectorListDecisionsInputSchema = z
  .object({
    candidateId: z.string().uuid().optional(),
    decisionType: memoryDecisionTypeSchema.optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(MEMORY_INSPECTOR_LIST_MAX_LIMIT)
      .default(MEMORY_INSPECTOR_LIST_DEFAULT_LIMIT),
  })
  .strict();
export type MemoryInspectorListDecisionsInput = z.infer<
  typeof memoryInspectorListDecisionsInputSchema
>;

/** Input for `memoryInspector.jobsSummary`. Bounded recent-jobs window. */
export const memoryInspectorJobsSummaryInputSchema = z
  .object({
    recentLimit: z
      .number()
      .int()
      .positive()
      .max(MEMORY_INSPECTOR_RECENT_JOBS_MAX_LIMIT)
      .default(MEMORY_INSPECTOR_RECENT_JOBS_DEFAULT_LIMIT),
  })
  .strict();
export type MemoryInspectorJobsSummaryInput = z.infer<
  typeof memoryInspectorJobsSummaryInputSchema
>;

// ── DTOs ────────────────────────────────────────────────────────

/**
 * One memory candidate, sanitized. `status` parses STRICTLY (the lifecycle
 * vocabulary is CHECK-constrained — drift must fail loudly); `source` is
 * `null` when a row carries a value outside the known set (S9 coerceSource
 * display-tolerance precedent).
 */
export const memoryCandidateDtoSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    title: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
    source: longMemorySourceSchema.nullable(),
    confidence: z.number().nullable(),
    importance: z.number().int(),
    sensitivity: memoryCandidateSensitivitySchema,
    evidenceStrength: memoryCandidateEvidenceStrengthSchema,
    retrievalVisibility: memoryCandidateRetrievalVisibilitySchema,
    status: memoryCandidateStatusSchema,
    recordedAt: z.string().datetime({ offset: true }),
    promotedKnowledgeId: z.number().int().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MemoryCandidateDto = z.infer<typeof memoryCandidateDtoSchema>;

export const memoryInspectorListCandidatesResultSchema = z.array(
  memoryCandidateDtoSchema,
);
export type MemoryInspectorListCandidatesResult = z.infer<
  typeof memoryInspectorListCandidatesResultSchema
>;

/**
 * One manager decision, sanitized. `id` is the BIGINT audit id — kept as a
 * string (precision-safe, matches the pg driver's int8 representation).
 */
export const memoryDecisionDtoSchema = z
  .object({
    id: z.string(),
    candidateId: z.string().uuid().nullable(),
    reconcileEntryId: z.number().int().nullable(),
    jobId: z.number().int(),
    decisionVersion: z.number().int(),
    decisionType: memoryDecisionTypeSchema,
    rejectReason: memoryDecisionRejectReasonSchema.nullable(),
    promotedKnowledgeId: z.number().int().nullable(),
    supersedesKnowledgeId: z.number().int().nullable(),
    mergeTargetKnowledgeId: z.number().int().nullable(),
    outcomeVersion: z.number().int().nullable(),
    inferenceProvider: z.string().nullable(),
    inferenceModel: z.string().nullable(),
    costUsd: z.number().nullable(),
    decidedBy: memoryDecisionActorSchema,
    decidedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MemoryDecisionDto = z.infer<typeof memoryDecisionDtoSchema>;

export const memoryInspectorListDecisionsResultSchema = z.array(
  memoryDecisionDtoSchema,
);
export type MemoryInspectorListDecisionsResult = z.infer<
  typeof memoryInspectorListDecisionsResultSchema
>;

/**
 * One recent job row. Item progress (`itemsDone`/`itemsFailed`/`itemsTotal`)
 * is DERIVED from `memory_job_items` in the read query — never stored.
 * NOTE: `lastError`/`lastErrorCode` are deliberately ABSENT (strict object —
 * carrying them fails the parse); see the module header before re-adding.
 */
export const memoryJobDtoSchema = z
  .object({
    id: z.number().int(),
    jobKind: memoryJobKindSchema,
    status: memoryJobStatusSchema,
    attemptCount: z.number().int(),
    maxAttempts: z.number().int(),
    wakePending: z.boolean(),
    nextAttemptAt: z.string().datetime({ offset: true }).nullable(),
    itemsDone: z.number().int().nonnegative(),
    itemsFailed: z.number().int().nonnegative(),
    itemsTotal: z.number().int().nonnegative(),
    costUsd: z.number().nullable(),
    llmCallCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type MemoryJobDto = z.infer<typeof memoryJobDtoSchema>;

/** Result for `memoryInspector.jobsSummary` — queue counters + recent jobs. */
export const memoryJobsSummaryDtoSchema = z
  .object({
    countsByStatus: z
      .object({
        pending: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        permanently_failed: z.number().int().nonnegative(),
        retired: z.number().int().nonnegative(),
      })
      .strict(),
    recentJobs: z.array(memoryJobDtoSchema),
  })
  .strict();
export type MemoryJobsSummaryDto = z.infer<typeof memoryJobsSummaryDtoSchema>;
