/**
 * `up -d` internals. This wraps the cwd-based `docker compose up -d`
 * invocation (M11.5.4 — `cwd: composeDir`, never `-f`). The migration owns
 * all decision and result-shaping logic; this helper owns only the spawn
 * contract and its timeout so the no-`-f` guarantee lives in one place.
 */

import { runSpawn, type SpawnRunnerResult } from "../docker/spawn-runner.js";
import { composeArgs } from "./project.js";

// First-run `up -d` triggers the init container's ~333 MB GGUF download
// from HuggingFace; on slow connections this can exceed the old 2 min
// budget. 15 min covers a 350 KB/s tail. Subsequent runs return in
// seconds (sha256-verified cache short-circuits the download).
export const UP_TIMEOUT_MS = 15 * 60_000;

export interface ComposeSpawnContext {
  readonly composeDir: string;
  readonly signal?: AbortSignal;
  readonly onLogLine?: (stream: "stdout" | "stderr", line: string) => void;
  /**
   * Bring up only these services (and what they depend on). Omitted: the
   * whole project. The data migration starts `db` alone.
   */
  readonly services?: readonly string[];
}

/**
 * `docker compose up -d` against the auto-discovered project in
 * `composeDir`. The migration uses it to bring the previous release's `db`
 * service up, and again after a non-destructive recreate.
 */
export async function composeUpDetached(
  ctx: ComposeSpawnContext
): Promise<SpawnRunnerResult> {
  const { composeDir, signal, onLogLine } = ctx;
  return runSpawn("docker", composeArgs(["up", "-d", ...(ctx.services ?? [])]), {
    cwd: composeDir,
    timeoutMs: UP_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
    onStdoutLine: (line) => onLogLine?.("stdout", line),
    onStderrLine: (line) => onLogLine?.("stderr", line),
  });
}
