/**
 * Pre-setup-only stale bind-mount / secret cache recovery. After a
 * Docker Desktop restart the daemon can reference an old bind-mount hash
 * whose backing directory was wiped, so `up -d` fails with
 * "no such file or directory". Recovery tears the project down INCLUDING
 * its volumes and resets per-install state — destructive, so the wipe is
 * gated to the explicit pre-setup state ONLY (codex round 2 RED #1 +
 * round 3 RED #1). Post-setup (or unknown status) the caller surfaces a
 * non-destructive, support-guided recovery message instead.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { runSpawn } from "../docker/spawn-runner.js";
import { wizardStateStore } from "../onboarding/wizard-state-store.js";
import { SETUP_COMPLETE_FILE } from "../paths/config-dir.js";
import { type RenderDeps } from "./render.js";
import { composeArgs, projectName } from "./project.js";

export { STALE_BIND_MOUNT_RE } from "./recreate.js";

export interface ClearStaleSecretCacheResult {
  readonly wiped: boolean;
}

/**
 * Fail-safe "setup completed" gate (codex round 3 RED #1). Returns
 * true if ANY signal indicates the user finalized setup OR if the
 * state is unknown — only the explicit pre-setup combination
 * (wizard.completed===false AND no `.setup-complete` marker) permits
 * the destructive wipe path. `wizardState.completed` is the
 * authoritative source per `finalize.ts`; the marker file is
 * belt-and-suspenders.
 */
async function isSetupLikelyCompleted(): Promise<boolean> {
  let markerPresent = false;
  try {
    await fs.access(SETUP_COMPLETE_FILE);
    markerPresent = true;
  } catch {
    // marker absent — fall through to wizardState check
  }
  if (markerPresent) return true;
  // peekCompleted does NOT create defaults; null = unknown.
  const wizardCompleted = await wizardStateStore.peekCompleted();
  // Fail-safe: only the explicit `false` permits the wipe; null
  // (unknown / corrupt) is treated as "assume completed" so we never
  // destroy data when we cannot prove the operator is still in setup.
  return wizardCompleted !== false;
}

export async function clearStaleSecretCache(
  deps: RenderDeps,
  outPath: string,
  installId: string,
  onLogLine?: (stream: "stdout" | "stderr", line: string) => void,
  signal?: AbortSignal
): Promise<ClearStaleSecretCacheResult> {
  // Codex review round 2 RED #1 + round 3 RED #1 — destructive
  // recovery gate. The original M5 logic tears the project down
  // INCLUDING its volumes (Postgres data, embeddings cache, knowledge
  // entries) because pre-M7 there was no user data worth preserving.
  // Post-setup we MUST refuse to wipe; the caller surfaces a
  // non-destructive manual recovery message instead of silently
  // destroying user state.
  if (await isSetupLikelyCompleted()) {
    onLogLine?.(
      "stderr",
      "[recovery] Stale bind-mount cache detected, but setup is already complete (or its status cannot be confirmed) — refusing to wipe user data."
    );
    return { wiped: false };
  }
  // Codex turn 14 RED #2 — destructive path must honour cancellation.
  // If the user cancelled before we enter the wipe stage, bail without
  // touching anything; the caller will surface internal.cancelled.
  if (signal?.aborted === true) {
    return { wiped: false };
  }

  // Pre-setup wipe is safe — no user-owned state yet. Regenerating the
  // password forces a new Docker bind-mount hash (so the stale-cache
  // symptom clears); the existing empty volume would otherwise still
  // hold `pg_authid` with the OLD password and authentication would
  // fail with `password authentication failed for user "vex"`.
  // `outPath` lives inside `composeDir`; pass `cwd` so Compose
  // auto-discovers `docker-compose.yml` instead of going through the
  // path-concatenation bugs in `docker/compose#12669` / `#7101`.
  await runSpawn(
    "docker",
    composeArgs([
      "-p",
      projectName(installId),
      "down",
      "--remove-orphans",
      "--volumes",
    ]),
    {
      cwd: path.dirname(outPath),
      timeoutMs: 30_000,
      ...(signal !== undefined ? { signal } : {}),
      onStdoutLine: (line) => onLogLine?.("stdout", `[recovery] ${line}`),
      onStderrLine: (line) => onLogLine?.("stderr", `[recovery] ${line}`),
    }
  );
  // Bail BEFORE any file removal if the user cancelled while the
  // `compose down` subprocess was running. Removing the install-id /
  // secrets / compose tree is the destructive part — refusing here
  // keeps the on-disk state recoverable.
  if (signal?.aborted === true) {
    return { wiped: false };
  }
  // Reset all per-install state so the next render regenerates a fresh
  // install_id, password, and compose YAML. The new install_id yields
  // a brand-new volume namespace, and the new password hash forces
  // Docker Desktop to recompute its bind-mount cache.
  const installIdPath = path.join(deps.userDataDir, ".install-id");
  const secretsDir = path.join(deps.userDataDir, "local-infra", "secrets");
  const composeDir = path.join(deps.userDataDir, "compose");
  for (const target of [installIdPath, secretsDir, composeDir]) {
    if (signal?.aborted === true) {
      // Stop mid-loop — partial wipe is still safe (the next composeUp
      // run will detect the incomplete state and re-clear on retry).
      return { wiped: false };
    }
    try {
      await fs.rm(target, { recursive: true, force: true });
      onLogLine?.("stdout", `[recovery] Cleared ${target}`);
    } catch (err: unknown) {
      onLogLine?.(
        "stderr",
        `[recovery] Failed to clear ${target}: ${
          err instanceof Error ? err.message : "unknown"
        }`
      );
    }
  }
  return { wiped: true };
}
