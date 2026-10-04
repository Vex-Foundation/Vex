import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  CURRENT_KDF_PARAMS,
  VAULT_VERSION,
  decryptContents,
  emptyContents,
  encryptContents,
  encryptContentsKeepingKey,
  parseVaultFile,
  vaultFileNeedsKdfUpgrade,
  type VaultFile,
} from "./crypto.js";
import type {
  LocalSecretVaultCacheOptions,
  VaultKeyCacheOperation,
  VaultTimingOperation,
} from "./derived-key-cache.js";

/**
 * Per-vault-file serialisation.
 *
 * The KDF is async (it runs on the libuv threadpool so a ~400ms derive never
 * freezes the main thread), which means a vault operation now yields to the
 * event loop between reading the file and writing it back. When the KDF was
 * synchronous every create / unlock (with its KDF-upgrade rewrite) / write was
 * one uninterrupted read-modify-write. This queue keeps exactly that: the
 * operations that read and then (may) rewrite a given vault file run one at a
 * time, in call order, so two concurrent writes can never both read the old
 * contents and have the later rename silently drop the other's update.
 *
 * A failed operation never blocks the next one (the chain does not poison).
 * `verifySecretVaultPassword` stays outside the queue: it never writes, and
 * the atomic rename means it always reads one whole file.
 */
const vaultFileQueues = new Map<string, Promise<void>>();

function withVaultFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const previous = vaultFileQueues.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  vaultFileQueues.set(key, tail);
  void tail.then(() => {
    if (vaultFileQueues.get(key) === tail) vaultFileQueues.delete(key);
  });
  return result;
}

let atomicWriteSeq = 0;

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // The sequence keeps two writes in the same millisecond (two vault files in
  // one directory, now that writes interleave) from sharing a temp path.
  atomicWriteSeq += 1;
  const tmp = join(dir, `.secrets.vault.${process.pid}.${Date.now()}.${atomicWriteSeq}.tmp`);
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

/**
 * Run one vault operation under the per-file lock. Without an opt-in
 * `derivedKeyCache` this is exactly the uncached call. With one, the
 * operation is bound to the cache generation current at REQUEST time, so a
 * lock that clears the cache while this call waits for the file lock or for
 * its KDF can never have a key stored after it.
 */
function withVaultOperation<T>(
  options: LocalSecretVaultCacheOptions,
  op: VaultTimingOperation,
  fn: (keyCache: VaultKeyCacheOperation | undefined) => Promise<T>,
): Promise<T> {
  const filePath = resolveVaultPath(options);
  const cache = options.derivedKeyCache ?? null;
  if (cache === null) return withVaultFileLock(filePath, () => fn(undefined));
  const requestedAtMs = performance.now();
  const generation = cache.generation;
  return withVaultFileLock(filePath, async () => {
    const keyCache = cache.beginOperation(filePath, op, options.timingLabel, requestedAtMs, generation);
    try {
      return await fn(keyCache);
    } finally {
      keyCache.finish();
    }
  });
}

/**
 * Encrypt with a fresh random salt and write atomically. A cached operation
 * also keeps the key it just derived for that new salt, once the write has
 * landed, so the next read is a hit; an older entry (old salt) is replaced.
 */
async function writeEncryptedVault(
  filePath: string,
  contents: LocalSecretVaultContents,
  password: string,
  keyCache: VaultKeyCacheOperation | undefined,
): Promise<void> {
  if (keyCache === undefined) {
    atomicWriteJson(filePath, await encryptContents(contents, password));
    return;
  }
  const started = performance.now();
  let encrypted: { readonly file: VaultFile; readonly salt: Buffer; readonly key: Buffer };
  try {
    encrypted = await encryptContentsKeepingKey(contents, password);
  } finally {
    keyCache.derives += 1;
    keyCache.deriveMs += performance.now() - started;
  }
  try {
    atomicWriteJson(filePath, encrypted.file);
    if (keyCache.current) {
      keyCache.cache.store(
        filePath,
        encrypted.salt,
        CURRENT_KDF_PARAMS,
        password,
        encrypted.key,
        keyCache.generation,
      );
    }
  } finally {
    encrypted.key.fill(0);
  }
}

export function createSecretVault(
  password: string,
  options: LocalSecretVaultOptions = {},
): Promise<LocalSecretVaultContents> {
  return withVaultFileLock(resolveVaultPath(options), () =>
    createSecretVaultLocked(password, options),
  );
}

async function createSecretVaultLocked(
  password: string,
  options: LocalSecretVaultOptions,
): Promise<LocalSecretVaultContents> {
  const filePath = resolveVaultPath(options);
  if (existsSync(filePath)) {
    // Creating a vault is an authentication path: never the key cache.
    return unlockSecretVaultLocked(password, options, undefined);
  }

  const contents = emptyContents();
  atomicWriteJson(filePath, await encryptContents(contents, password));
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
export async function verifySecretVaultPassword(
  password: string,
  options: LocalSecretVaultOptions = {},
): Promise<void> {
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
  await decryptContents(parsedFile, password);
}

/**
 * Decrypt the vault. `options.derivedKeyCache` is the opt-in
 * `VAULT_DERIVED_KEY_CACHE` path for unlocked-session reads that use the
 * session's own held password; an unlock attempt with a typed password never
 * passes it and always derives.
 */
export function unlockSecretVault(
  password: string,
  options: LocalSecretVaultCacheOptions = {},
): Promise<LocalSecretVaultContents> {
  return withVaultOperation(options, "read", (keyCache) =>
    unlockSecretVaultLocked(password, options, keyCache),
  );
}

async function unlockSecretVaultLocked(
  password: string,
  options: LocalSecretVaultOptions,
  keyCache: VaultKeyCacheOperation | undefined,
): Promise<LocalSecretVaultContents> {
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
  const contents = await decryptContents(parsedFile, password, keyCache);

  // Opportunistically re-encrypt with CURRENT_KDF_PARAMS when the on-disk
  // params are weaker (or otherwise drift from the current scheme). A failure
  // here MUST NOT block unlock — the caller still has correctly decrypted
  // secrets; the next successful unlock or write will retry the rewrite.
  if (vaultFileNeedsKdfUpgrade(parsedFile)) {
    try {
      await writeEncryptedVault(filePath, contents, password, keyCache);
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
  options: LocalSecretVaultCacheOptions = {},
): Promise<LocalSecretVaultContents> {
  return withVaultOperation(options, "write", (keyCache) =>
    writeSecretVaultSecretsLocked(password, updates, options, keyCache),
  );
}

async function writeSecretVaultSecretsLocked(
  password: string,
  updates: Partial<Record<VaultSecretKey, string | null>>,
  options: LocalSecretVaultOptions,
  keyCache: VaultKeyCacheOperation | undefined,
): Promise<LocalSecretVaultContents> {
  const current = secretVaultExists(options)
    ? await unlockSecretVaultLocked(password, options, keyCache)
    : await createSecretVaultLocked(password, options);
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
  await writeEncryptedVault(resolveVaultPath(options), next, password, keyCache);
  return next;
}

export function writeSecretVaultExtraSecrets(
  password: string,
  updates: Readonly<Record<string, string | null>>,
  options: LocalSecretVaultCacheOptions = {},
): Promise<LocalSecretVaultContents> {
  return withVaultOperation(options, "write", (keyCache) =>
    writeSecretVaultExtraSecretsLocked(password, updates, options, keyCache),
  );
}

async function writeSecretVaultExtraSecretsLocked(
  password: string,
  updates: Readonly<Record<string, string | null>>,
  options: LocalSecretVaultOptions,
  keyCache: VaultKeyCacheOperation | undefined,
): Promise<LocalSecretVaultContents> {
  const current = secretVaultExists(options)
    ? await unlockSecretVaultLocked(password, options, keyCache)
    : await createSecretVaultLocked(password, options);
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
  await writeEncryptedVault(resolveVaultPath(options), next, password, keyCache);
  return next;
}
