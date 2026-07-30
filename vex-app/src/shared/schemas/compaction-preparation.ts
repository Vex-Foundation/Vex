/**
 * Compaction-PREPARATION schemas (compaction v2, package C10).
 *
 * A separate file from `schemas/compaction.ts` on purpose: that domain owns
 * the Track-2 `compact_jobs` worker surface, this one owns the v2
 * `compaction_preparations` FSM — different tables, different lifecycles,
 * different reasons to change.
 *
 * The status vocabularies are RE-DECLARED here rather than imported, the same
 * doctrine documented on `schemas/compaction.ts`: `shared/` must not depend on
 * `src/vex-agent`. Drift against the engine's own `PreparationStatus`
 * (`db/repos/compaction-preparations/types.ts`) surfaces as a Zod parse
 * failure at the IPC boundary rather than as a silent mismatch.
 *
 * ## The DTO is the leak surface
 *
 * `compaction_preparations` stores a verbatim frozen copy of the conversation
 * (`corpus`) and a model-authored condensation of it (`summary_output`), plus
 * a free-text `last_error` that can carry provider prose. NONE of them appear
 * below, and no field here is a free string at all: the DTO is scalars, closed
 * enums and ISO timestamps. Readiness is reported as the boolean `hasSummary`,
 * never as the summary. The internal preparation id is likewise absent — the
 * apply request targets the session, mirroring the retry handler's rule that
 * an internal job id never reaches the renderer.
 */

import { z } from "zod";

export const COMPACTION_PREPARATION_STATUSES = [
  "preparing",
  "summary_ready",
  "apply_requested",
  "applying",
  "applied",
  "failed",
  "superseded",
] as const;

export const compactionPreparationStatusSchema = z.enum(
  COMPACTION_PREPARATION_STATUSES,
);
export type CompactionPreparationStatusDto = z.infer<
  typeof compactionPreparationStatusSchema
>;

/** Branch A (summary) lifecycle. `permanently_failed` = attempts exhausted. */
export const COMPACTION_SUMMARY_BRANCH_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "permanently_failed",
] as const;
export const compactionSummaryBranchStatusSchema = z.enum(
  COMPACTION_SUMMARY_BRANCH_STATUSES,
);

/** Branch B (memory chunks). `frozen` = output snapshotted, insert pending. */
export const COMPACTION_CHUNKS_BRANCH_STATUSES = [
  "pending",
  "running",
  "frozen",
  "succeeded",
  "failed",
  "permanently_failed",
] as const;
export const compactionChunksBranchStatusSchema = z.enum(
  COMPACTION_CHUNKS_BRANCH_STATUSES,
);

/** Who asked for the cutover. Bounded enum — provenance, not prose. */
export const COMPACTION_APPLY_SOURCES = [
  "ui_button",
  "agent_tool",
  "auto_full_autonomous",
  "forced_critical",
] as const;
export const compactionApplySourceSchema = z.enum(COMPACTION_APPLY_SOURCES);

export const compactionPreparationInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type CompactionPreparationInput = z.infer<
  typeof compactionPreparationInputSchema
>;

/**
 * The session's most recent preparation, bounded to progress facts.
 *
 * The branch-B (`chunks*`) fields are carried because they are cheap and
 * bounded and the audit surface is specified to live on the preparation row;
 * the runtime bar renders nothing for them today.
 */
export const compactionPreparationDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    status: compactionPreparationStatusSchema,
    summaryStatus: compactionSummaryBranchStatusSchema,
    chunksStatus: compactionChunksBranchStatusSchema,
    summaryAttemptCount: z.number().int().min(0),
    summaryMaxAttempts: z.number().int().min(0),
    chunksAttemptCount: z.number().int().min(0),
    chunksMaxAttempts: z.number().int().min(0),
    /** Branch A produced a summary. Never the summary itself. */
    hasSummary: z.boolean(),
    applySource: compactionApplySourceSchema.nullable(),
    applyRequestedAt: z.string().datetime({ offset: true }).nullable(),
    appliedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type CompactionPreparationDto = z.infer<
  typeof compactionPreparationDtoSchema
>;

/**
 * `null` when the session has no preparation at all, or is unknown /
 * soft-deleted / outside the app scope — a normal state, never an error shape
 * (mirrors `compaction.getStatus`).
 */
export const compactionPreparationResultSchema =
  compactionPreparationDtoSchema.nullable();
export type CompactionPreparationResult = z.infer<
  typeof compactionPreparationResultSchema
>;

export const compactionApplyRequestInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type CompactionApplyRequestInput = z.infer<
  typeof compactionApplyRequestInputSchema
>;

/**
 * The honest outcomes of ONE compare-and-swap `summary_ready → apply_requested`.
 * Every one of these is a SUCCESSFUL `Result` — racing the runtime is expected,
 * not an error. Only a genuinely absent or foreign session is an error
 * (`compaction.not_found`).
 *
 *  - `queued` — the CAS won and a live runner lease exists to consume it.
 *  - `no_live_runner` — the CAS won and the request is durable, but nothing is
 *    running right now. The state is identical to `queued`; only the copy
 *    differs, because promising "applies at the next step" would be a lie.
 *  - `already_requested` — a request was already standing; this added nothing.
 *  - `not_ready` — the live preparation is not `summary_ready`.
 *  - `gone` — there is no live preparation for the session any more.
 */
export const compactionApplyRequestResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("queued"),
        status: compactionPreparationStatusSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("no_live_runner"),
        status: compactionPreparationStatusSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("already_requested"),
        status: compactionPreparationStatusSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("not_ready"),
        status: compactionPreparationStatusSchema,
      })
      .strict(),
    z.object({ outcome: z.literal("gone") }).strict(),
  ],
);
export type CompactionApplyRequestResult = z.infer<
  typeof compactionApplyRequestResultSchema
>;

/**
 * The push event that invalidates the preparation query. Metadata only, and
 * emitted by the engine ONLY after the transaction that made the row fetchable
 * has committed (see `engine/runtime/compaction-bus.ts`).
 */
export const compactionPreparationEventSchema = z
  .object({
    type: z.literal("engine.compaction.preparation"),
    sessionId: z.string().uuid(),
    status: compactionPreparationStatusSchema,
    summaryReady: z.boolean(),
    correlationId: z.string().nullable(),
  })
  .strict();
export type CompactionPreparationEvent = z.infer<
  typeof compactionPreparationEventSchema
>;
