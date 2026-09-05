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
  // Indexify (custodial Solana stacks venue). This key ALONE authorizes real
  // trades on the linked Indexify account, so it is vault-managed like a
  // wallet secret. Gates the authenticated indexify tools via `requiresEnv`;
  // the public discovery reads stay keyless.
  "INDEXIFY_API_KEY",
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
