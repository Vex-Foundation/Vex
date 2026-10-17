/**
 * `<RUNTIME_DIR>/runtime-state.json`: what the native runtime must remember
 * between launches.
 *
 *   pg.systemIdentifier  the cluster's identity (D6), recorded once the
 *                        bootstrap (initdb + CREATE DATABASE vex) completed
 *   pg.lastPort          the port tried first next launch (D5)
 *   pg.major             the major the data dir was created by
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

export const PG_MAJOR = 18;

const pgStateSchema = z.looseObject({
  systemIdentifier: z.string().regex(/^\d+$/),
  lastPort: z.number().int().min(1).max(65535).nullable(),
  major: z.literal(PG_MAJOR),
});

const runtimeStateSchema = z.looseObject({
  pg: pgStateSchema.nullable(),
});

export type PgRuntimeState = z.infer<typeof pgStateSchema>;
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
