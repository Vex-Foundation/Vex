import { existsSync } from "node:fs";
import { SECRETS_VAULT_FILE } from "../../config/paths.js";
import type { VaultSecretKey } from "../secret-keys.js";
import type { VAULT_VERSION } from "./crypto.js";

export interface LocalSecretVaultOptions {
  readonly filePath?: string;
}

export interface LocalSecretVaultStatus {
  readonly configured: boolean;
}

export interface LocalSecretVaultContents {
  readonly version: typeof VAULT_VERSION;
  readonly secrets: Partial<Record<VaultSecretKey, string>>;
  /**
   * Secret keys this build does not recognize. Preserved on read so a
   * newer vault can open on an older build without looking "corrupt", and
   * round-tripped on the next write so a downgrade cannot strip them.
   */
  readonly extraSecrets?: Readonly<Record<string, string>>;
}

export class LocalSecretVaultError extends Error {
  constructor(
    message: string,
    /**
     * - `invalid_password` — scrypt/AES-GCM failed (wrong password or
     *   tampered ciphertext; those are indistinguishable).
     * - `incompatible` — password verified, but plaintext shape/version
     *   is too new for this build. MUST NOT advance unlock throttle.
     * - `corrupt` — envelope or plaintext is structurally unreadable.
     * - `missing` / `io` — file absence / filesystem errors.
     */
    readonly code: "missing" | "invalid_password" | "corrupt" | "io" | "incompatible",
    // `override`: shadows Error.cause (lib ES2022+); explicit for
    // vex-app's noImplicitOverride typecheck profile.
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LocalSecretVaultError";
  }
}

export function resolveVaultPath(options: LocalSecretVaultOptions): string {
  return options.filePath ?? SECRETS_VAULT_FILE;
}

export function secretVaultExists(options: LocalSecretVaultOptions = {}): boolean {
  return existsSync(resolveVaultPath(options));
}

export function getSecretVaultStatus(
  options: LocalSecretVaultOptions = {},
): LocalSecretVaultStatus {
  return { configured: secretVaultExists(options) };
}
