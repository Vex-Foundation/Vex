/**
 * Lifecycle helper for compose secret hygiene (codex turn 5 RED #2).
 *
 * Two cleanup paths:
 *   1. `cleanupOnQuit()` — invoked from the `before-quit` hook. Stops
 *      any running compose project owned by this install AND removes
 *      transient secret files written during the session.
 *   2. `cleanupOnBoot()` — invoked once after `app.whenReady`. Sweeps
 *      the canonical secrets directory for `*.transient` files left
 *      behind by a prior crash. If the corresponding compose project is
 *      not currently active, the orphan is removed.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { runSpawn } from "../docker/spawn-runner.js";
import {
  COMPOSE_OUTPUT_DIR,
  INSTALL_ID_FILE,
  SECRETS_DIR,
} from "../paths/config-dir.js";
import { composeDown } from "../compose/lifecycle.js";

const TRANSIENT_SUFFIX = ".transient";

async function readInstallId(): Promise<string | null> {
  try {
    const content = await fs.readFile(INSTALL_ID_FILE, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function isProjectActive(installId: string): Promise<boolean> {
  const result = await runSpawn(
    "docker",
    [
      "ps",
      "--filter",
      `label=com.docker.compose.project=vex-${installId}`,
      "--format",
      "{{.ID}}",
    ],
    { gracePeriodMs: 1_000 }
  );
  if (result.code !== 0) return false;
  return result.stdout.trim().length > 0;
}

export async function cleanupOnBoot(): Promise<void> {
  const installId = await readInstallId();

  // Sweep transient files that were left behind by a prior crash.
  let entries: string[] = [];
  try {
    entries = await fs.readdir(SECRETS_DIR);
  } catch {
    return;
  }
  const transients = entries.filter((name) => name.endsWith(TRANSIENT_SUFFIX));
  if (transients.length === 0) return;

  // If the project is currently running, leave its transient in place —
  // a still-running container is consuming the file via `secrets:` mount.
  const projectAlive = installId !== null ? await isProjectActive(installId) : false;
  if (projectAlive) return;

  for (const name of transients) {
    const full = path.join(SECRETS_DIR, name);
    try {
      await fs.unlink(full);
    } catch {
      // Best-effort; silent.
    }
  }
}

export async function cleanupOnQuit(): Promise<void> {
  const installId = await readInstallId();
  if (installId === null) return;

  // Best-effort `compose stop` (skill §10 — never `--volumes` on quit).
  const composeOutPath = path.join(COMPOSE_OUTPUT_DIR, "docker-compose.yml");
  try {
    await fs.access(composeOutPath);
    await composeDown(composeOutPath, installId);
  } catch {
    // Compose output may not exist if the user never started services.
  }

  // Sweep transient files. Even if `compose stop` failed, the stack
  // is on its way down and the plaintext should not survive the quit.
  await sweepTransientSecrets();
}

/** Remove every `*.transient` secret file; the native runtime's quit runs it too. */
export async function sweepTransientSecrets(): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(SECRETS_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(TRANSIENT_SUFFIX)) continue;
    const full = path.join(SECRETS_DIR, name);
    try {
      await fs.unlink(full);
    } catch {
      // Silent.
    }
  }
}
