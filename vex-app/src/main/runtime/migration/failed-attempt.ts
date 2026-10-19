/**
 * What explains a failed data move, kept through its rollback: the tool's
 * complete stderr and the database server's own log, which the logging
 * collector writes inside the data dir the rollback is about to delete.
 *
 * The server log is MOVED out (a rename within the runtime dir), not copied:
 * the collector may still be writing when the postmaster has exited, and a
 * rename keeps its late lines in the kept file. It also costs no disk.
 *
 * One attempt only: each kept failure replaces the previous one, so the
 * directory holds at most one stderr (runPgTool keeps 1 MiB) and one log
 * directory. A later successful retry leaves it in place: that is when
 * someone asks why the first attempt failed.
 *
 * Never the dump, data files, the password or the pgpass file.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../../logger/index.js";
import type { PgClientTool } from "./pg-tool-failure.js";

export interface FailedToolRun {
  readonly name: PgClientTool;
  readonly code: number | null;
  readonly stderr: string;
}

/** Per artifact: kept, could not be kept, or there was nothing to keep. */
export type KeptState = "kept" | "not_kept" | "none";

export interface KeptFailedAttempt {
  readonly dir: string;
  readonly tool: PgClientTool | null;
  readonly toolOutput: KeptState;
  readonly serverLog: KeptState;
}

const SERVER_LOG_DIR = "server-log";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isDirectory(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => null))?.isDirectory() === true;
}

/**
 * Replace `dir` with this attempt's evidence. Returns null when there was
 * nothing to keep or the directory could not be made; never throws, so the
 * caller still reports the primary failure.
 */
export async function keepFailedAttempt(input: {
  readonly dir: string;
  readonly reason: string;
  readonly message: string;
  readonly at: string;
  readonly tool: FailedToolRun | null;
  /** The cluster's log dir; only for a cluster the rollback deletes next. */
  readonly serverLogDir: string | null;
}): Promise<KeptFailedAttempt | null> {
  const hasServerLog = input.serverLogDir !== null && (await isDirectory(input.serverLogDir));
  if (input.tool === null && !hasServerLog) return null;
  try {
    await fs.rm(input.dir, { recursive: true, force: true });
    await fs.mkdir(input.dir, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    log.warn(`[runtime:migration] could not keep the failed attempt's output in ${input.dir}: ${messageOf(error)}`);
    return null;
  }

  let toolOutput: KeptState = "none";
  if (input.tool !== null) {
    try {
      await fs.writeFile(path.join(input.dir, `${input.tool.name}.stderr.txt`), input.tool.stderr, { mode: 0o600 });
      toolOutput = "kept";
    } catch (error: unknown) {
      log.warn(`[runtime:migration] could not keep the ${input.tool.name} output: ${messageOf(error)}`);
      toolOutput = "not_kept";
    }
  }

  let serverLog: KeptState = "none";
  if (hasServerLog && input.serverLogDir !== null) {
    try {
      await fs.rename(input.serverLogDir, path.join(input.dir, SERVER_LOG_DIR));
      serverLog = "kept";
    } catch (error: unknown) {
      log.warn(`[runtime:migration] could not keep the database server's log: ${messageOf(error)}`);
      serverLog = "not_kept";
    }
  }

  const kept: KeptFailedAttempt = { dir: input.dir, tool: input.tool?.name ?? null, toolOutput, serverLog };
  const record = {
    reason: input.reason,
    message: input.message,
    at: input.at,
    tool: input.tool === null ? null : { name: input.tool.name, exitCode: input.tool.code },
    toolOutput,
    serverLog,
  };
  await fs
    .writeFile(path.join(input.dir, "failure.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    .catch((error: unknown) => log.warn(`[runtime:migration] could not write failure.json: ${messageOf(error)}`));
  return kept;
}

/** The sentence a failure message ends with, saying exactly what was kept and where. */
export function keptSentence(kept: KeptFailedAttempt): string {
  const keptParts: string[] = [];
  const lostParts: string[] = [];
  const toolLabel = `the full ${kept.tool ?? "tool"} output`;
  if (kept.toolOutput === "kept") keptParts.push(toolLabel);
  if (kept.toolOutput === "not_kept") lostParts.push(toolLabel);
  if (kept.serverLog === "kept") keptParts.push("the database server's log");
  if (kept.serverLog === "not_kept") lostParts.push("the database server's log");
  const sentences: string[] = [];
  if (keptParts.length > 0) {
    const what = keptParts.join(" and ");
    sentences.push(`${what.charAt(0).toUpperCase()}${what.slice(1)} ${keptParts.length > 1 ? "were" : "was"} kept in ${kept.dir}.`);
  }
  if (lostParts.length > 0) {
    const what = lostParts.join(" and ");
    sentences.push(`${what.charAt(0).toUpperCase()}${what.slice(1)} could not be kept; the app log says why.`);
  }
  return sentences.join(" ");
}
