import {
  applySecretVaultToProcessEnv,
  createSecretVault,
  getSecretVaultStatus,
  LocalSecretVaultError,
  stripManagedSecretsFromDotenvFile,
  unlockSecretVault,
  writeSecretVaultSecrets,
} from "@vex-lib/local-secret-vault.js";
import {
  MANAGED_SECRET_ENV_KEYS,
  MASTER_PASSWORD_ENV_KEY,
  VAULT_SECRET_KEYS,
  type VaultSecretKey,
} from "@vex-lib/secret-keys.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  setKeystorePasswordProvider,
  clearKeystorePasswordProvider,
} from "@utils/env.js";
import { ENV_FILE, SECRETS_VAULT_FILE } from "../paths/config-dir.js";
import { log } from "../logger/index.js";

let unlockedMasterPassword: string | null = null;

export type SecretSessionLifecycleState = "unlocked" | "locked";
export type SecretSessionLifecycleListener = (
  state: SecretSessionLifecycleState,
) => void;

const secretSessionLifecycleListeners = new Set<SecretSessionLifecycleListener>();

/**
 * Main-process-only lifecycle signal. It carries no password, secret, vault
 * contents, or credential metadata. Privileged consumers use it to immediately
 * revoke derived capabilities (for example authenticated read streams) on lock.
 */
export function onSecretSessionLifecycle(
  listener: SecretSessionLifecycleListener,
): () => void {
  secretSessionLifecycleListeners.add(listener);
  return () => {
    secretSessionLifecycleListeners.delete(listener);
  };
}

function emitSecretSessionLifecycle(state: SecretSessionLifecycleState): void {
  for (const listener of secretSessionLifecycleListeners) {
    try {
      listener(state);
    } catch {
      // A capability cleanup listener must never make vault lock/unlock fail.
      log.warn("[secrets-session] lifecycle listener failed", { state });
    }
  }
}

/**
 * Placeholder correlation id for session-layer errors built outside an IPC
 * handler (this module has no `requestId` of its own). `registerHandler`
 * rewrites `correlationId` to the request's real id whenever it detects a
 * mismatch (see `register-handler.ts`), so this value never reaches the
 * renderer — it only needs to be a non-empty string to satisfy `VexError`.
 */
const SESSION_LOCAL_CORRELATION_ID = "secrets-session";

/**
 * Stable provider handed to the root keystore-password chokepoint (`@utils/env`).
 * Reads `unlockedMasterPassword` LIVE at decrypt time, so in-process signing
 * (chat / mission / approval / protocol handlers) can decrypt the wallet key
 * without the master password ever being written to `process.env`. Returns `null`
 * when locked → `requireKeystorePassword()` throws → signing fails closed.
 */
const keystorePasswordProvider = (): string | null => unlockedMasterPassword;

export interface SecretSessionStatus {
  readonly vaultConfigured: boolean;
  readonly unlocked: boolean;
}

export interface SecretPresence {
  readonly vaultConfigured: boolean;
  readonly unlocked: boolean;
  readonly secrets: Partial<Record<VaultSecretKey, boolean>>;
}

function toPublicError(cause: unknown): Result<never> {
  if (cause instanceof LocalSecretVaultError && cause.code === "invalid_password") {
    return err({
      code: "wallet.password_invalid",
      domain: "wallet",
      message: "Master password is incorrect.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  // The vault was written by a newer build — either the OUTER envelope
  // (detected before decryption, so the password is NOT necessarily
  // verified) or the decrypted contents version (after auth passed).
  // Distinct from `invalid_password` so the unlock throttle never advances
  // and the user is told to update Vex, not to retype the password.
  if (cause instanceof LocalSecretVaultError && cause.code === "incompatible") {
    return err({
      code: "wallet.vault_incompatible",
      domain: "wallet",
      message: "This vault was created by a newer version of Vex. Update Vex to open it.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  // Envelope/KDF-params/plaintext structurally invalid. Distinct from
  // `wallet.keystore_corrupt` (the separate wallet SIGNING keystore) so the
  // user is never told their wallet is broken when it is the API-secrets
  // vault. Never advances the unlock throttle — a corrupt file is not an
  // attacker/typo signal.
  // Crypto-runtime/allocation failure — the vault may be perfectly intact.
  // RETRYABLE, and never "restore from a backup": that guidance is for a
  // genuinely corrupt file, not a transient system error. Never advances
  // the unlock throttle (the gate keys on wallet.password_invalid only).
  if (cause instanceof LocalSecretVaultError && cause.code === "unavailable") {
    return err({
      code: "wallet.vault_unavailable",
      domain: "wallet",
      message: "Unlocking failed due to a system error. Try again.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  if (cause instanceof LocalSecretVaultError && cause.code === "corrupt") {
    return err({
      code: "wallet.vault_corrupt",
      domain: "wallet",
      message:
        "The secret vault file is unreadable. Restore it from a backup — do not wipe your wallet keystores.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  if (cause instanceof LocalSecretVaultError && cause.code === "missing") {
    return err({
      code: "wallet.vault_not_configured",
      domain: "wallet",
      message: "Master password is not configured. Complete setup first.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  log.error("[secrets-session] secret vault operation failed", cause);
  return err({
    code: "onboarding.env_persist_failed",
    domain: "onboarding",
    message: "Could not access the encrypted secret vault. Check disk permissions and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId: SESSION_LOCAL_CORRELATION_ID,
  });
}

function applyUnlockedRuntime(password: string): void {
  applySecretVaultToProcessEnv(password, { filePath: SECRETS_VAULT_FILE });
  delete process.env[MASTER_PASSWORD_ENV_KEY];
  // Hand the live in-memory password to the root keystore chokepoint so signing
  // resolves it WITHOUT re-introducing it to env. Idempotent (re-register on
  // every unlock/init/adopt/write); scrubUnlockedRuntime revokes it on lock.
  setKeystorePasswordProvider(keystorePasswordProvider);
}

export function getSecretSessionStatus(): SecretSessionStatus {
  return {
    vaultConfigured: getSecretVaultStatus({ filePath: SECRETS_VAULT_FILE }).configured,
    unlocked: unlockedMasterPassword !== null,
  };
}

export function initializeMasterPassword(
  password: string,
): Result<{ readonly kind: "set" | "unchanged" }> {
  try {
    const existed = getSecretVaultStatus({ filePath: SECRETS_VAULT_FILE }).configured;
    createSecretVault(password, { filePath: SECRETS_VAULT_FILE });
    unlockedMasterPassword = password;
    applyUnlockedRuntime(password);
    stripManagedSecretsFromDotenvFile(ENV_FILE);
    emitSecretSessionLifecycle("unlocked");
    return ok({ kind: existed ? "unchanged" : "set" });
  } catch (cause) {
    return toPublicError(cause);
  }
}

export function unlockSecretSession(
  password: string,
): Result<{ readonly unlocked: true }> {
  try {
    unlockSecretVault(password, { filePath: SECRETS_VAULT_FILE });
    unlockedMasterPassword = password;
    applyUnlockedRuntime(password);
    stripManagedSecretsFromDotenvFile(ENV_FILE);
    emitSecretSessionLifecycle("unlocked");
    return ok({ unlocked: true });
  } catch (cause) {
    return toPublicError(cause);
  }
}

/**
 * Synchronous part of a relock (FINDING-security-003): drop the cached master
 * password reference AND remove every managed secret the unlock flow injected
 * into `process.env`. Synchronous on purpose — callers in sync contexts (quit
 * hooks, the sync `getUnlockedSecretPresence` failure path) get the scrub before
 * any `await`, so the security guarantee never depends on a pending microtask.
 *
 * Sweeps `MANAGED_SECRET_ENV_KEYS` (master-password key + all vault keys), not
 * just `VAULT_SECRET_KEYS`, so a relock leaves NO managed secret in env.
 */
function scrubUnlockedRuntime(): void {
  const wasUnlocked = unlockedMasterPassword !== null;
  unlockedMasterPassword = null;
  for (const key of MANAGED_SECRET_ENV_KEYS) {
    delete process.env[key];
  }
  // Revoke the signing capability atomically with the env scrub: after this the
  // chokepoint falls back to env-only, which is also scrubbed → signing fails
  // closed until the next unlock re-registers the provider.
  clearKeystorePasswordProvider();
  if (wasUnlocked) emitSecretSessionLifecycle("locked");
}

/**
 * Invalidate the engine's cached inference provider after a relock. Required
 * because `resolveProvider()` returns its `cachedProvider` BEFORE re-reading
 * env — deleting `process.env.OPENROUTER_API_KEY` alone would not stop a
 * previously-resolved provider instance from continuing to serve. Dynamic
 * import keeps the engine off the main bundle's static graph (boundary rule);
 * a failure here is logged but never fails the lock.
 */
async function invalidateProviderCache(): Promise<void> {
  try {
    const { resetProvider } = await import("@vex-agent/inference/registry.js");
    resetProvider();
  } catch (err) {
    log.warn("[secrets-session] resetProvider after lock failed", err);
  }
}

/**
 * Relock the secret session. Scrubs the cached master password and every
 * managed secret from `process.env`, then invalidates the engine's cached
 * inference provider so post-lock turns cannot reuse the old credentials.
 *
 * The env/password scrub is synchronous and runs before the first `await`, so
 * fire-and-forget callers (quit hooks) still get the hard scrub. Explicit lock
 * paths (`vex:secrets:lock` IPC, export-failure lockout) MUST `await` this so
 * the provider cache is provably cleared before they report success. JS strings
 * are immutable, so nulling the reference + GC is the strongest in-process
 * defense for the residual password string. `global.gc` only exists with
 * `--expose-gc`; the GC hint is best-effort.
 */
export async function lockSecretSession(): Promise<void> {
  scrubUnlockedRuntime();
  await invalidateProviderCache();
  if (typeof global.gc === "function") global.gc();
}

/**
 * Adopt a master password as the unlocked session AFTER an external mutation
 * swapped the on-disk vault file (C2 archive restore). The restore primitive
 * has already written the new `secrets.vault.json`; this refreshes
 * `process.env` from that RESTORED vault and marks the session unlocked with
 * the supplied password — the same in-memory state `unlockSecretSession`
 * establishes, but WITHOUT re-running `unlockSecretVault` first (the caller
 * already proved the password decrypts the restored vault by completing the
 * restore). Throws `LocalSecretVaultError` if the restored vault cannot be
 * read with `password`; callers map it through `mapWalletEngineError` /
 * `toPublicError`. NEVER logs the password.
 */
export function adoptUnlockedPassword(password: string): void {
  applyUnlockedRuntime(password);
  unlockedMasterPassword = password;
  stripManagedSecretsFromDotenvFile(ENV_FILE);
  emitSecretSessionLifecycle("unlocked");
}

export function requireUnlockedMasterPassword(): Result<string> {
  if (unlockedMasterPassword !== null) return ok(unlockedMasterPassword);
  return err({
    code: "wallet.keystore_locked",
    domain: "wallet",
    message: "Unlock Vex with your master password before using wallets or secrets.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId: SESSION_LOCAL_CORRELATION_ID,
  });
}

export function writeUnlockedSecrets(
  updates: Partial<Record<VaultSecretKey, string | null>>,
): Result<void> {
  const passwordResult = requireUnlockedMasterPassword();
  if (!passwordResult.ok) return passwordResult;

  try {
    writeSecretVaultSecrets(passwordResult.data, updates, {
      filePath: SECRETS_VAULT_FILE,
    });
    applyUnlockedRuntime(passwordResult.data);
    stripManagedSecretsFromDotenvFile(ENV_FILE);
    return ok(undefined);
  } catch (cause) {
    return toPublicError(cause);
  }
}

/**
 * Read ONE stored secret from the unlocked vault, main-process only.
 *
 * Lives here because this module already owns the vault session (write +
 * presence); a second read path elsewhere would be a second place to get the
 * lock/scrub discipline wrong. `ok(null)` means "vault readable, this key is
 * not set" — distinct from a locked/corrupt vault, which returns the mapped
 * error so the caller can surface the real reason.
 *
 * The returned value is a SECRET. It must never be logged, echoed into an
 * error message, or returned across IPC — the only sanctioned use is handing
 * it to a main-side verifier/writer.
 */
export function readUnlockedSecret(
  key: VaultSecretKey,
): Result<string | null> {
  const passwordResult = requireUnlockedMasterPassword();
  if (!passwordResult.ok) return passwordResult;

  try {
    const contents = unlockSecretVault(passwordResult.data, {
      filePath: SECRETS_VAULT_FILE,
    });
    const value = contents.secrets[key];
    return ok(typeof value === "string" && value.length > 0 ? value : null);
  } catch (cause) {
    return toPublicError(cause);
  }
}

export function getUnlockedSecretPresence(): SecretPresence {
  const status = getSecretSessionStatus();
  const secrets: Partial<Record<VaultSecretKey, boolean>> = {};
  if (!status.vaultConfigured || unlockedMasterPassword === null) {
    return { ...status, secrets };
  }

  try {
    const contents = unlockSecretVault(unlockedMasterPassword, {
      filePath: SECRETS_VAULT_FILE,
    });
    for (const key of VAULT_SECRET_KEYS) {
      secrets[key] = Boolean(contents.secrets[key]);
    }
    return { ...status, secrets };
  } catch (cause) {
    log.warn("[secrets-session] presence probe failed; locking vault", cause);
    // Defensive relock: same scrub as an explicit lock (env + password), but
    // this getter is synchronous so the provider-cache reset is fire-and-forget.
    // The env/password scrub IS synchronous, so the security guarantee holds
    // before we return; only the cache invalidation lands on a later microtask.
    scrubUnlockedRuntime();
    void invalidateProviderCache();
    return { vaultConfigured: status.vaultConfigured, unlocked: false, secrets: {} };
  }
}
