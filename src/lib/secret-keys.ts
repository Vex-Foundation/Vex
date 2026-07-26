export const MASTER_PASSWORD_ENV_KEY = "VEX_KEYSTORE_PASSWORD" as const;

export const VAULT_SECRET_KEYS = [
  "OPENROUTER_API_KEY",
  // Optional second inference key used only after the primary exhausts its
  // transient retries (see inference/failover.ts). Managed exactly like the
  // primary key: encrypted in the vault, mirrored to process.env at unlock,
  // and stripped from .env.
  "OPENROUTER_API_KEY_FALLBACK",
  "JUPITER_API_KEY",
  "TAVILY_API_KEY",
  "RETTIWT_API_KEY",
  // Polymarket integration removed (Agent Scan §4.6): the 4 POLYMARKET_* keys
  // were dropped from this registry deliberately. Any already-vaulted values
  // are NOT migrated or purged here — the vault's `extraSecrets` retention
  // path (local-secret-vault/crypto.ts) leaves them inert on disk forever,
  // never mirrored to process.env again. A future consent-gated purge is a
  // separate follow-up; never print or re-derive these values.
] as const;

export type VaultSecretKey = (typeof VAULT_SECRET_KEYS)[number];

export const MANAGED_SECRET_ENV_KEYS = [
  MASTER_PASSWORD_ENV_KEY,
  ...VAULT_SECRET_KEYS,
] as const;

export function isVaultSecretKey(key: string): key is VaultSecretKey {
  return (VAULT_SECRET_KEYS as readonly string[]).includes(key);
}

export function isManagedSecretEnvKey(key: string): boolean {
  return (MANAGED_SECRET_ENV_KEYS as readonly string[]).includes(key);
}
