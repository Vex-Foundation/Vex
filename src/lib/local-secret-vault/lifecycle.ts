import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  VAULT_SECRET_KEYS,
  isVaultSecretKey,
  type VaultSecretKey,
} from "../secret-keys.js";
import {
  LocalSecretVaultError,
  resolveVaultPath,
  secretVaultExists,
  type LocalSecretVaultContents,
  type LocalSecretVaultOptions,
} from "./status.js";
import {
  VAULT_VERSION,
  decryptContents,
  emptyContents,
  encryptContents,
  parseVaultFile,
  vaultFileNeedsKdfUpgrade,
} from "./crypto.js";

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = join(dir, `.secrets.vault.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  } catch (cause) {
    throw new LocalSecretVaultError("Could not write secret vault.", "io", cause);
  }
}

export function createSecretVault(
  password: string,
  options: LocalSecretVaultOptions = {},
): LocalSecretVaultContents {
  const filePath = resolveVaultPath(options);
  if (existsSync(filePath)) {
    return unlockSecretVault(password, options);
  }

  const contents = emptyContents();
  atomicWriteJson(filePath, encryptContents(contents, password));
  return contents;
}

/**
 * Verify the master password against the on-disk vault without unlocking the
 * session, upgrading KDF params, or returning the decrypted payload. Used for
 * sudo-style re-authentication on sensitive ops (e.g. wallet private-key
 * export) that should NOT mutate session state or write to disk.
 *
 * Throws `LocalSecretVaultError` with code:
 *   - "missing"          — vault file does not exist
 *   - "corrupt"          — envelope/KDF-params invalid, or plaintext
 *                          unreadable after authentication passed
 *   - "unavailable"      — crypto-runtime (scrypt/setup or post-auth
 *                          decode) failure — retryable; the file may be fine
 *   - "incompatible"     — the vault (outer envelope OR inner contents)
 *                          was written by a newer build. The OUTER check
 *                          fires BEFORE decryption, so `incompatible` does
 *                          NOT always imply the password was verified.
 *   - "invalid_password" — GCM auth-tag failure at decipher.final() ONLY
 *                          (wrong password
 *                          or tampered ciphertext; indistinguishable). Never
 *                          used for post-decrypt shape/version issues.
 *
 * Returns `undefined` on success — by design no secrets are returned.
 * No disk write on success or failure (no opportunistic KDF upgrade).
 */
export function verifySecretVaultPassword(
  password: string,
  options: LocalSecretVaultOptions = {},
): void {
  const filePath = resolveVaultPath(options);
  if (!existsSync(filePath)) {
    throw new LocalSecretVaultError("Secret vault is not configured.", "missing");
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new LocalSecretVaultError("Could not read secret vault.", "io", cause);
  }

  // parseVaultFile raises `corrupt` on JSON/schema failure and
  // `incompatible` for a too-new outer envelope — surface as-is.
  const parsedFile = parseVaultFile(raw);

  // decryptContents classifies per the split taxonomy: only a GCM auth-tag
  // failure at decipher.final() is `invalid_password`; scrypt/setup runtime
  // failures are `unavailable` (retryable); structural issues are `corrupt`.
  // Discard the decrypted payload — verification only needs to confirm the
  // password unwraps the vault; callers MUST NOT use this to harvest secrets.
  decryptContents(parsedFile, password);
}

export function unlockSecretVault(
  password: string,
  options: LocalSecretVaultOptions = {},
): LocalSecretVaultContents {
  const filePath = resolveVaultPath(options);
  if (!existsSync(filePath)) {
    throw new LocalSecretVaultError("Secret vault is not configured.", "missing");
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new LocalSecretVaultError("Could not read secret vault.", "io", cause);
  }
  const parsedFile = parseVaultFile(raw);
  const contents = decryptContents(parsedFile, password);

  // Opportunistically re-encrypt with CURRENT_KDF_PARAMS when the on-disk
  // params are weaker (or otherwise drift from the current scheme). A failure
  // here MUST NOT block unlock — the caller still has correctly decrypted
  // secrets; the next successful unlock or write will retry the rewrite.
  if (vaultFileNeedsKdfUpgrade(parsedFile)) {
    try {
      atomicWriteJson(filePath, encryptContents(contents, password));
    } catch (cause) {
      // Surface via process.emitWarning instead of pulling in a logger
      // dependency at this layer; secret-session.ts already wraps callers
      // in a try/catch that maps LocalSecretVaultError. Mirrors the existing
      // best-effort pattern used elsewhere in this module.
      process.emitWarning(
        `Secret vault KDF upgrade rewrite failed; vault still usable with stale params: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { type: "LocalSecretVaultKdfUpgrade" },
      );
    }
  }

  return contents;
}

export function writeSecretVaultSecrets(
  password: string,
  updates: Partial<Record<VaultSecretKey, string | null>>,
  options: LocalSecretVaultOptions = {},
): LocalSecretVaultContents {
  const current = secretVaultExists(options)
    ? unlockSecretVault(password, options)
    : createSecretVault(password, options);
  const nextSecrets: Partial<Record<VaultSecretKey, string>> = {
    ...current.secrets,
  };

  for (const key of VAULT_SECRET_KEYS) {
    if (!(key in updates)) continue;
    const value = updates[key];
    if (typeof value === "string" && value.length > 0) nextSecrets[key] = value;
    else delete nextSecrets[key];
  }

  const next: LocalSecretVaultContents = {
    version: VAULT_VERSION,
    secrets: nextSecrets,
    // Preserve any keys from a newer vault this build does not recognize so
    // a write here cannot strip them (forward-compat round-trip).
    ...(current.extraSecrets && Object.keys(current.extraSecrets).length > 0
      ? { extraSecrets: current.extraSecrets }
      : {}),
  };
  atomicWriteJson(resolveVaultPath(options), encryptContents(next, password));
  return next;
}

export function writeSecretVaultExtraSecrets(
  password: string,
  updates: Readonly<Record<string, string | null>>,
  options: LocalSecretVaultOptions = {},
): LocalSecretVaultContents {
  const current = secretVaultExists(options)
    ? unlockSecretVault(password, options)
    : createSecretVault(password, options);
  const nextExtraSecrets: Record<string, string> = {
    ...(current.extraSecrets ?? {}),
  };

  for (const [key, value] of Object.entries(updates)) {
    if (isVaultSecretKey(key)) continue;
    if (typeof value === "string" && value.length > 0) {
      nextExtraSecrets[key] = value;
    } else {
      delete nextExtraSecrets[key];
    }
  }

  const next: LocalSecretVaultContents = {
    version: VAULT_VERSION,
    secrets: { ...current.secrets },
    ...(Object.keys(nextExtraSecrets).length > 0
      ? { extraSecrets: nextExtraSecrets }
      : {}),
  };
  atomicWriteJson(resolveVaultPath(options), encryptContents(next, password));
  return next;
}
