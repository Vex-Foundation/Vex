/**
 * The Vex Cloud session bearer's one owner: the encrypted vault, key
 * `VEX_CLOUD_SESSION_TOKEN`.
 *
 * Writing goes through the secret session (`writeUnlockedSecrets`), which
 * re-mirrors the vault into `process.env` so the engine's Vex Cloud client
 * reads the same value, and relock scrubs it with every managed key. After
 * every change the engine's cached provider is reset: `resolveProvider()`
 * returns its cached instance before re-reading env, so without the reset a
 * removed bearer could keep serving (the same reason `lockSecretSession`
 * resets it).
 *
 * The value is a SECRET. Nothing here logs it or returns it across IPC.
 */

import { err, ok, type Result } from "@shared/ipc/result.js";
import { log } from "../logger/index.js";
import { readUnlockedSecret, writeUnlockedSecrets } from "../secrets/session.js";

export const VEX_CLOUD_SESSION_KEY = "VEX_CLOUD_SESSION_TOKEN" as const;

async function resetEngineProvider(): Promise<void> {
  try {
    const { resetProvider } = await import("@vex-agent/inference/registry.js");
    resetProvider();
  } catch (cause) {
    log.warn("[vex-cloud] resetProvider after a session change failed", {
      type: cause instanceof Error ? cause.name : typeof cause,
    });
  }
}

/** The stored bearer, `null` when none is stored, or the vault's own error (locked, corrupt). */
export function readVexCloudSession(): Promise<Result<string | null>> {
  return readUnlockedSecret(VEX_CLOUD_SESSION_KEY);
}

export async function storeVexCloudSession(token: string): Promise<Result<void>> {
  if (token.length === 0) {
    return err({
      code: "internal.unexpected",
      domain: "vexCloud",
      message: "Vex Inference returned an empty session. Nothing was stored; sign in again.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId: "vex-cloud-session",
    });
  }
  const written = await writeUnlockedSecrets({ [VEX_CLOUD_SESSION_KEY]: token });
  if (!written.ok) return written;
  await resetEngineProvider();
  return ok(undefined);
}

/** Remove the stored bearer. Idempotent: clearing an absent one succeeds. */
export async function clearVexCloudSession(): Promise<Result<void>> {
  const written = await writeUnlockedSecrets({ [VEX_CLOUD_SESSION_KEY]: null });
  if (!written.ok) return written;
  await resetEngineProvider();
  return ok(undefined);
}
