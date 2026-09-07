export const MASTER_PASSWORD_ENV_KEY = "VEX_KEYSTORE_PASSWORD" as const;

export const VAULT_SECRET_KEYS = [
  "OPENROUTER_API_KEY",
  "JUPITER_API_KEY",
  "TAVILY_API_KEY",
  "RETTIWT_API_KEY",
  // OPTIONAL. Relay bridging works fully without it; a key only raises Relay's
  // rate limits. Deliberately NOT a `requiresEnv` on any relay manifest — that
  // would hide the bridge tools from every keyless user.
  "RELAY_API_KEY",
  // Polymarket integration removed (Agent Scan §4.6): the 4 POLYMARKET_* keys
  // were dropped from this registry deliberately. Any already-vaulted values
  // are NOT migrated or purged here — the vault's `extraSecrets` retention
  // path (local-secret-vault/crypto.ts) leaves them inert on disk forever,
  // never mirrored to process.env again. A future consent-gated purge is a
  // separate follow-up; never print or re-derive these values.
  //
  // LIGHTER_CORE_READ_ONLY_AUTH_TOKEN / LIGHTER_RHC_READ_ONLY_AUTH_TOKEN
  // removed: the standalone-token bypass let a stale pasted token silently
  // block withdrawal/order-read auth that would otherwise derive correctly
  // from the actually-registered trading credential via the local signer.
  // Same non-migration policy as Polymarket above — any already-vaulted
  // value goes inert, never purged or mirrored to process.env again.
] as const;

export type VaultSecretKey = (typeof VAULT_SECRET_KEYS)[number];

/**
 * Former vault-backed environment names that must remain scrubbed forever.
 *
 * They are deliberately excluded from `VAULT_SECRET_KEYS`, so unlocking the
 * vault never injects them into `process.env`. Keeping them in the managed-env
 * set still removes legacy plaintext values from dotenv files, clears any
 * inherited runtime values on relock, and prevents child processes from
 * receiving them.
 */
export const RETIRED_SECRET_ENV_KEYS = [
  "LIGHTER_CORE_READ_ONLY_AUTH_TOKEN",
  "LIGHTER_RHC_READ_ONLY_AUTH_TOKEN",
] as const;

export const MANAGED_SECRET_ENV_KEYS = [
  MASTER_PASSWORD_ENV_KEY,
  ...VAULT_SECRET_KEYS,
  ...RETIRED_SECRET_ENV_KEYS,
] as const;

export function isVaultSecretKey(key: string): key is VaultSecretKey {
  return (VAULT_SECRET_KEYS as readonly string[]).includes(key);
}

export function isManagedSecretEnvKey(key: string): boolean {
  return (MANAGED_SECRET_ENV_KEYS as readonly string[]).includes(key);
}
