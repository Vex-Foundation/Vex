/**
 * `<RUNTIME_DIR>/runtime-state.json`: what the native runtime must remember
 * between launches.
 *
 *   pg.systemIdentifier  the cluster's identity (D6), recorded once the
 *                        bootstrap (initdb + CREATE DATABASE vex) completed
 *   pg.lastPort          the port tried first next launch (D5)
 *   pg.major             the major the data dir was created by
 *   provider             "native" once this install's data lives in the
 *                        native cluster: copied from the previous release's
 *                        container volume, or started fresh in its place
 *   migration            that copy, step by step, so a crash, quit or update
 *                        resumes it (plan section 10, `migration/`)
 *
 * `pg` is null until the bootstrap completes, so "the cluster exists but was
 * never finished" and "no cluster" are both visible as `pg === null`.
 *
 * A missing file is a fresh install. A file that exists but does not parse is
 * REFUSED with `RuntimeStateCorruptError`, never silently reset: the recorded
 * system_identifier is the ownership proof, and quietly re-recording it would
 * let whatever answers on the port next be adopted as ours.
 *
 * Unknown top-level and `pg` keys are kept on rewrite, so a newer build's
 * fields survive a launch of an older one.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PreviousReleaseData } from "@shared/schemas/system.js";

export const PG_MAJOR = 18;

const pgStateSchema = z.looseObject({
  systemIdentifier: z.string().regex(/^\d+$/),
  lastPort: z.number().int().min(1).max(65535).nullable(),
  major: z.literal(PG_MAJOR),
});

/**
 * The last step the migration COMPLETED, in order. `completed` is terminal;
 * every other value means the migration is in progress and owns the native
 * cluster, which nothing else may start or write into until it completes.
 */
export const MIGRATION_STEPS = ["started", "dumped", "restored", "verified", "completed"] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];

const migrationFailureSchema = z.looseObject({
  kind: z.string().min(1),
  message: z.string(),
  at: z.string(),
});

const migrationStateSchema = z.looseObject({
  /** The install whose volume is being read; bound once, at `started`. */
  installId: z.string().min(1),
  step: z.enum(MIGRATION_STEPS),
  /** Set with `completed`: the data was copied, or the user started fresh. */
  outcome: z.enum(["migrated", "fresh"]).nullable(),
  /** The dump's sha256 and size, recorded with `dumped`; null before. */
  dump: z.looseObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() }).nullable(),
  attempts: z.number().int().nonnegative(),
  lastFailure: migrationFailureSchema.nullable(),
  /** Whether the old stack was confirmed stopped when the migration completed. */
  oldStackStopped: z.boolean().nullable(),
  /**
   * When the previous release's data was removed (Settings), after the
   * migration completed. Absent while that data may still exist.
   */
  oldDataRemovedAt: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
});

const runtimeStateSchema = z.looseObject({
  pg: pgStateSchema.nullable(),
  provider: z.literal("native").optional(),
  migration: migrationStateSchema.optional(),
});

export type PgRuntimeState = z.infer<typeof pgStateSchema>;
export type MigrationState = z.infer<typeof migrationStateSchema>;
export type MigrationFailureRecord = z.infer<typeof migrationFailureSchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export const EMPTY_RUNTIME_STATE: RuntimeState = { pg: null };

export class RuntimeStateCorruptError extends Error {
  constructor(
    readonly filePath: string,
    reason: string,
  ) {
    super(`The runtime state file ${filePath} is unreadable (${reason}); it was left untouched.`);
    this.name = "RuntimeStateCorruptError";
  }
}

export async function readRuntimeState(filePath: string): Promise<RuntimeState> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_RUNTIME_STATE;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new RuntimeStateCorruptError(filePath, "not JSON");
  }
  const parsed = runtimeStateSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RuntimeStateCorruptError(
      filePath,
      issue === undefined ? "invalid" : `${issue.path.join(".") || "root"}: ${issue.message}`,
    );
  }
  return parsed.data;
}

/**
 * Whether the previous release's data may still exist: a migration that
 * completed (moved, or started fresh beside it) and whose old data was not
 * removed since. Settings offers the removal only then.
 */
export function previousReleaseData(state: RuntimeState): PreviousReleaseData {
  const migration = state.migration;
  if (migration?.step !== "completed" || migration.oldDataRemovedAt !== undefined) return { kind: "none" };
  return { kind: "kept", imported: migration.outcome === "migrated" };
}

/** Atomic: a crash mid-write leaves the previous file, never a torn one. */
export async function writeRuntimeState(filePath: string, state: RuntimeState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (err: unknown) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}
