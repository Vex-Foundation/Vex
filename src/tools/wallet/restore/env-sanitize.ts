/**
 * `.env` sanitization + restored-vault detection for restore (crypto-sensitive).
 *
 * Two pure-ish helpers used by the commit phase + orchestrator:
 *   - `sanitizeDotenv`: drop every MANAGED secret line from a restored `.env`
 *     (the vault is the source of truth after restore; leaving managed secrets
 *     in `.env` would defeat the vault and risk plaintext key exposure).
 *   - `detectVaultLocked`: AFTER commit, check whether the LIVE restored vault
 *     opens with the supplied password. Detection only — applying secrets to
 *     process.env is the vex-app handler's job. Called post-commit in the
 *     orchestrator so it inspects the committed live vault, never staged bytes.
 *
 * Engine/main only — never imported by the renderer.
 */

import { isManagedSecretEnvKey } from "../../../lib/secret-keys.js";
import {
  LocalSecretVaultError,
  unlockSecretVault,
} from "../../../lib/local-secret-vault.js";

/**
 * Drop every line whose key is a MANAGED secret (master password + all vault
 * secret keys). Preserves everything else verbatim — comments, blanks, quoting.
 * The vault is the source of truth for managed secrets after restore; leaving
 * them in `.env` would defeat the vault and risk plaintext key exposure.
 */
export function sanitizeDotenv(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      kept.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) {
      kept.push(line);
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    if (isManagedSecretEnvKey(key)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * vaultLocked: does the restored vault open with `password`? (Detection
 * only — applying secrets to process.env is the vex-app handler's job.)
 * MUST be called AFTER commit so it inspects the live restored vault.
 */
export async function detectVaultLocked(password: string): Promise<boolean> {
  let vaultLocked = false;
  try {
    await unlockSecretVault(password);
  } catch (err) {
    if (err instanceof LocalSecretVaultError && err.code === "invalid_password") {
      vaultLocked = true;
    } else {
      // corrupt / io / missing — treat as locked (cannot confirm unlock).
      vaultLocked = true;
    }
  }
  return vaultLocked;
}
