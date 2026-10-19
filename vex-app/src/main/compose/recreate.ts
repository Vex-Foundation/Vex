/**
 * Non-destructive project recreation — issue #26. After a Docker Desktop
 * restart the daemon can reference a wiped bind-mount cache hash, so
 * `up -d` fails with "no such file or directory" ({@link STALE_BIND_MOUNT_RE}).
 * The previous release's stale-secret wipe (`down --volumes` +
 * regenerated password + reset install state) was destructive and gated to
 * PRE-SETUP only. This module is the POST-SETUP-safe alternative: recreating
 * the containers forces Docker Desktop to rebuild the bind-mount cache for
 * the UNCHANGED secret file, so `pg_authid` still matches and nothing is
 * lost — never pass `--volumes` here, and never touch the secret file.
 */

import { runSpawn, type SpawnRunnerResult } from "../docker/spawn-runner.js";
import { composeArgs, projectName } from "./project.js";
import { composeUpDetached, type ComposeSpawnContext } from "./up.js";

/** The `up -d` failure a stale Docker Desktop bind-mount cache produces. */
export const STALE_BIND_MOUNT_RE = /docker-desktop-bind-mounts.*no such file/i;

/** `compose down --remove-orphans` (no `--volumes`) budget. */
export const RECREATE_DOWN_TIMEOUT_MS = 30_000;

export interface RecreateProjectContext extends ComposeSpawnContext {
  readonly installId: string;
}

export interface RecreateProjectResult {
  readonly downResult: SpawnRunnerResult;
  readonly upResult: SpawnRunnerResult;
}

function skippedResult(): SpawnRunnerResult {
  return {
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
    aborted: true,
    timedOut: false,
  };
}

/**
 * `docker compose -p <project> down --remove-orphans` (containers + network
 * only — no `--volumes`, so the Postgres volume and the secret file mounted
 * at `/run/secrets/pg_password` are untouched) followed by exactly ONE
 * `up -d` retry. Recreating the containers rebuilds Docker Desktop's
 * bind-mount cache for the same, unchanged secret; since the password never
 * changes, the existing volume's `pg_authid` still matches and no data is
 * lost.
 *
 * Cancellation: if `signal` is already aborted, NEITHER command runs (both
 * results come back as synthetic aborted results). If it aborts after
 * `down` completes, `up` is skipped — `down` never touched user data, so a
 * partial cancellation here is always safe.
 */
export async function recreateProjectNonDestructively(
  ctx: RecreateProjectContext
): Promise<RecreateProjectResult> {
  const { composeDir, installId, signal, onLogLine } = ctx;
  // Read the abort flag through a function so TS does not narrow
  // `signal.aborted` from the first guard and then treat the post-`await`
  // re-check as unreachable — at runtime the flag CAN flip to true while
  // `down` runs (control-flow narrowing does not survive the await).
  const isAborted = (): boolean => signal?.aborted === true;

  if (isAborted()) {
    const skipped = skippedResult();
    return { downResult: skipped, upResult: skipped };
  }

  const downResult = await runSpawn(
    "docker",
    composeArgs(["-p", projectName(installId), "down", "--remove-orphans"]),
    {
      cwd: composeDir,
      timeoutMs: RECREATE_DOWN_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
      onStdoutLine: (line) => onLogLine?.("stdout", `[recreate] ${line}`),
      onStderrLine: (line) => onLogLine?.("stderr", `[recreate] ${line}`),
    }
  );

  if (isAborted()) {
    return { downResult, upResult: skippedResult() };
  }

  const upResult = await composeUpDetached({
    composeDir,
    ...(signal !== undefined ? { signal } : {}),
    ...(onLogLine !== undefined ? { onLogLine } : {}),
    ...(ctx.services !== undefined ? { services: ctx.services } : {}),
  });
  return { downResult, upResult };
}
