/**
 * Transient secret hygiene (codex turn 5 RED #2).
 *
 * Nothing writes a `*.transient` secret today (the secret adapter writes the
 * canonical file in place, `runtime/secrets/electron-secret-adapter.ts`), so
 * this is defence in depth: boot and quit both sweep the secrets directory so
 * a plaintext copy left by an older release or a crash never outlives a
 * session. No running process mounts one, so the sweep never has to wait.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { SECRETS_DIR } from "../paths/config-dir.js";

const TRANSIENT_SUFFIX = ".transient";

/** Remove every `*.transient` secret file. Best effort; never throws. */
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
