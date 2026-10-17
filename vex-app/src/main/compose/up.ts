/**
 * Pull / `up -d` orchestration internals. These wrap the cwd-based
 * `docker compose pull` and `docker compose up -d` invocations (M11.5.4
 * — `cwd: composeDir`, never `-f`). The lifecycle orchestrator owns all
 * decision and result-shaping logic; these helpers own only the spawn
 * contract and its timeouts so the no-`-f` guarantee lives in one place.
 */

import { runSpawn, type SpawnRunnerResult } from "../docker/spawn-runner.js";
import { composeArgs } from "./project.js";

export const PULL_TIMEOUT_MS = 10 * 60_000;   // 10 min for first pull on slow networks
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
 * Pull every image up-front. Implicit pull inside `up -d` blocks
 * without progress; `compose pull` lets us bound the call and stream
 * pull progress to the renderer log buffer. Pulls all services so
 * the embeddings stack's two images (llama.cpp:server + curlimages)
 * surface progress here too.
 */
export async function composePull(
  ctx: ComposeSpawnContext
): Promise<SpawnRunnerResult> {
  const { composeDir, signal, onLogLine } = ctx;
  return runSpawn("docker", composeArgs(["pull"]), {
    cwd: composeDir,
    timeoutMs: PULL_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
    onStdoutLine: (line) => onLogLine?.("stdout", line),
    onStderrLine: (line) => onLogLine?.("stderr", line),
  });
}

/**
 * `docker compose up -d` against the auto-discovered project in
 * `composeDir`. Used for the initial start, the existing-stack reuse
 * convergence kick, and the post-recovery retry.
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
