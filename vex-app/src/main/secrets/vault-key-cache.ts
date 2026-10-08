import {
  VaultDerivedKeyCache,
  type LocalSecretVaultCacheOptions,
  type VaultTimingRecord,
} from "@vex-lib/local-secret-vault/derived-key-cache.js";
import { SECRETS_VAULT_FILE } from "../paths/config-dir.js";

/**
 * SWITCH `VAULT_DERIVED_KEY_CACHE` (fastLighterClick FLC-0).
 *
 * ON keeps the scrypt-DERIVED vault key in main-process memory while the
 * session is unlocked, so an unlocked-session vault read stops paying the
 * scrypt derive (N=2^17, about 0.4 to 0.6 s in the app) on every open. A
 * Lighter key load opens the vault twice, so each one paid that twice.
 *
 * What stays exactly as before, ON or OFF:
 * - every password the user TYPES runs the full KDF: the unlock attempt,
 *   vault creation, wallet-export re-auth (`verifySecretVaultPassword`) and
 *   archive restore never pass the cache, so the unlock throttle sees the
 *   same results;
 * - every read still checks the GCM tag; a cached key that fails it is
 *   dropped and the read derives once from scratch;
 * - every write still encrypts under a fresh random salt.
 *
 * Only reads and writes that use the session's OWN held password (from
 * `requireUnlockedMasterPassword`) pass the cache, through
 * {@link unlockedSessionVaultOptions}. The cache holds no vault contents and
 * no decrypted secret, and it is dropped on every lock, unlock, vault
 * creation, restore adoption and session lifecycle event (see `session.ts`).
 *
 * OFF (`false`) passes no cache anywhere, which is exactly today's path.
 */
export const VAULT_DERIVED_KEY_CACHE = true;

/** Which unlocked-session caller ran a vault operation (timing label only). */
export type UnlockedVaultOperationLabel =
  | "secret_read"
  | "secret_presence"
  | "secrets_write"
  | "runtime_env"
  | "lighter_registration_state"
  | "lighter_key"
  | "lighter_status"
  | "lighter_scopes"
  | "lighter_pending_check"
  | "lighter_activation_check"
  | "lighter_write";

export interface VaultDerivedKeyCacheDeps {
  /** Overrides {@link VAULT_DERIVED_KEY_CACHE}; absent uses the constant. */
  readonly derivedKeyCache?: boolean;
}

let configuredDeps: VaultDerivedKeyCacheDeps = {};
let timingSink: ((record: VaultTimingRecord) => void) | null = null;

const processDerivedKeyCache = new VaultDerivedKeyCache({
  onTiming: (record) => timingSink?.(record),
});

/** Test and rollback seam for the switch. Returns a restore function. */
export function configureVaultDerivedKeyCacheDeps(
  deps: VaultDerivedKeyCacheDeps,
): () => void {
  const previous = configuredDeps;
  configuredDeps = deps;
  return () => {
    if (configuredDeps === deps) configuredDeps = previous;
  };
}

/** The `[vault-timing]` sink; `session.ts` points it at the main logger. */
export function setVaultTimingSink(
  sink: ((record: VaultTimingRecord) => void) | null,
): void {
  timingSink = sink;
}

export function isVaultDerivedKeyCacheEnabled(): boolean {
  return configuredDeps.derivedKeyCache ?? VAULT_DERIVED_KEY_CACHE;
}

/**
 * Vault options for a read or write that uses the session's own held
 * password. NEVER use this for a password the user typed.
 */
export function unlockedSessionVaultOptions(
  label: UnlockedVaultOperationLabel,
): LocalSecretVaultCacheOptions {
  if (!isVaultDerivedKeyCacheEnabled()) return { filePath: SECRETS_VAULT_FILE };
  return {
    filePath: SECRETS_VAULT_FILE,
    derivedKeyCache: processDerivedKeyCache,
    timingLabel: label,
  };
}

/** Drop every cached derived key (zero-filled, best effort). Always safe to call. */
export function dropVaultDerivedKeys(): void {
  processDerivedKeyCache.clear();
}

/** Number of vault files with a cached key; for tests and diagnostics. */
export function vaultDerivedKeyCacheEntryCount(): number {
  return processDerivedKeyCache.size;
}
