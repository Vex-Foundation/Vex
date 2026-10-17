/**
 * Schemas for moving an existing install's data from the previous release's
 * container stack into the native runtime (vex.system.runtimeMigration*).
 *
 * The "source" is that previous release's database: its Postgres volume, read
 * once over its own stack. Main maps the migration engine's vocabulary onto
 * these names (`runtime/migration/native-start-gate.ts`), so nothing past
 * main depends on that stack's tooling.
 *
 * While the status is anything but `not_needed`, main does not start the
 * native runtime: a migration in progress owns the native cluster.
 */

import { z } from "zod";

/** The last step an earlier attempt completed; the next one resumes after it. */
export const runtimeMigrationStepSchema = z.enum(["started", "dumped", "restored", "verified"]);
export type RuntimeMigrationStep = z.infer<typeof runtimeMigrationStepSchema>;

export const runtimeMigrationFailureReasonSchema = z.enum([
  /** The source stack's engine is not installed or not running. */
  "source_offline",
  /** This install's source database volume does not exist. */
  "source_volume_missing",
  /** The source database did not come up, or did not answer as this install's. */
  "source_unavailable",
  /** The source database has no schema: setup never finished there. */
  "source_empty",
  "disk_full",
  "dump_failed",
  /** The copy or its facts changed on disk between steps. */
  "dump_corrupt",
  /** The bundled Postgres tree is missing. */
  "native_unavailable",
  "native_start_failed",
  /** A server nobody could stop still holds the native data folder. */
  "native_cluster_busy",
  "restore_failed",
  /** The copy did not match the source. */
  "verify_failed",
  "state_unreadable",
  /** Another migration operation is running. */
  "busy",
  /** Nothing to move: native already, or no previous install. */
  "not_pending",
  "unexpected",
]);
export type RuntimeMigrationFailureReason = z.infer<typeof runtimeMigrationFailureReasonSchema>;

export const runtimeMigrationLastFailureSchema = z
  .object({
    reason: runtimeMigrationFailureReasonSchema,
    message: z.string(),
    at: z.string(),
  })
  .strict();
export type RuntimeMigrationLastFailure = z.infer<typeof runtimeMigrationLastFailureSchema>;

const seqSchema = z.number().int().nonnegative();
const bytesSchema = z.number().int().nonnegative();

/**
 * One step of a running migration. `seq` grows with every event, so a
 * renderer keeps the newest. `estimatedBytes` is the source database's live
 * size: the dump is compressed, so it usually ends well below it.
 */
export const runtimeMigrationProgressSchema = z.discriminatedUnion("phase", [
  z.object({ seq: seqSchema, phase: z.literal("preparing") }).strict(),
  z.object({ seq: seqSchema, phase: z.literal("starting_source") }).strict(),
  z
    .object({
      seq: seqSchema,
      phase: z.literal("dumping"),
      bytesWritten: bytesSchema,
      estimatedBytes: bytesSchema,
    })
    .strict(),
  z.object({ seq: seqSchema, phase: z.literal("restoring") }).strict(),
  z.object({ seq: seqSchema, phase: z.literal("verifying") }).strict(),
  z.object({ seq: seqSchema, phase: z.literal("finishing") }).strict(),
]);
export type RuntimeMigrationProgress = z.infer<typeof runtimeMigrationProgressSchema>;
export type RuntimeMigrationPhase = RuntimeMigrationProgress["phase"];

export const runtimeMigrationStatusSchema = z.discriminatedUnion("kind", [
  /** Nothing to move (or already moved): main starts the native runtime. */
  z.object({ kind: z.literal("not_needed") }).strict(),
  /** Blocking: setup may not continue until the data is moved or the user starts fresh. */
  z
    .object({
      kind: z.literal("pending"),
      resumeStep: runtimeMigrationStepSchema.nullable(),
      lastFailure: runtimeMigrationLastFailureSchema.nullable(),
    })
    .strict(),
  /** Pending, and the source's engine does not answer: it must run once. */
  z
    .object({
      kind: z.literal("pending_source_offline"),
      detail: z.string(),
      resumeStep: runtimeMigrationStepSchema.nullable(),
      lastFailure: runtimeMigrationLastFailureSchema.nullable(),
    })
    .strict(),
  /** The runtime state file does not parse or cannot be read; it was left untouched. */
  z.object({ kind: z.literal("state_unreadable"), message: z.string() }).strict(),
  /** A move or a start-fresh is running in main; calling it again joins it. */
  z
    .object({
      kind: z.literal("in_progress"),
      op: z.enum(["migrate", "start_fresh"]),
      progress: runtimeMigrationProgressSchema.nullable(),
    })
    .strict(),
]);
export type RuntimeMigrationStatus = z.infer<typeof runtimeMigrationStatusSchema>;

const failedSchema = z
  .object({
    kind: z.literal("failed"),
    reason: runtimeMigrationFailureReasonSchema,
    message: z.string(),
    /** Set for `disk_full` when the free space was measured. */
    requiredBytes: bytesSchema.nullable(),
    availableBytes: bytesSchema.nullable(),
  })
  .strict();
export type RuntimeMigrationFailed = z.infer<typeof failedSchema>;

export const runtimeMigrationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("migrated"), oldStackStopped: z.boolean(), message: z.string() }).strict(),
  z.object({ kind: z.literal("already_completed"), outcome: z.enum(["migrated", "fresh"]) }).strict(),
  /** Aborted by quit: the durable steps are kept and the next launch resumes. */
  z
    .object({ kind: z.literal("cancelled"), resumeStep: z.enum([...runtimeMigrationStepSchema.options, "completed"]) })
    .strict(),
  failedSchema,
]);
export type RuntimeMigrationResult = z.infer<typeof runtimeMigrationResultSchema>;

export const runtimeMigrationStartFreshResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started_fresh") }).strict(),
  failedSchema,
]);
export type RuntimeMigrationStartFreshResult = z.infer<typeof runtimeMigrationStartFreshResultSchema>;

/**
 * Remove the source's data (its volumes) once the move completed. After a
 * start-fresh it also needs `allowWithoutImport`: the volume is then the only
 * copy of that history.
 */
export const runtimeMigrationRemoveOldDataInputSchema = z
  .object({ allowWithoutImport: z.boolean() })
  .strict();
export type RuntimeMigrationRemoveOldDataInput = z.infer<typeof runtimeMigrationRemoveOldDataInputSchema>;

export const runtimeMigrationRemoveOldDataResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("removed"), message: z.string() }).strict(),
  z
    .object({
      kind: z.literal("refused"),
      reason: z.enum(["not_completed", "not_imported", "install_changed", "busy"]),
      message: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal("failed"), reason: z.enum(["source_offline", "failed"]), message: z.string() })
    .strict(),
]);
export type RuntimeMigrationRemoveOldDataResult = z.infer<typeof runtimeMigrationRemoveOldDataResultSchema>;
