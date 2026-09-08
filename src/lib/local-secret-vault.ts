/**
 * Compatibility façade for the encrypted local secret vault (KDF + AES-256-GCM).
 *
 * The implementation was split into `./local-secret-vault/` modules
 * (crypto / status / lifecycle / env) without any behavior change. This file
 * preserves the IDENTICAL public surface so existing importers keep working.
 */
export { CURRENT_KDF_PARAMS } from "./local-secret-vault/crypto.js";
export {
  LocalSecretVaultError,
  getSecretVaultStatus,
  secretVaultExists,
  type LocalSecretVaultContents,
  type LocalSecretVaultOptions,
  type LocalSecretVaultStatus,
} from "./local-secret-vault/status.js";
export {
  createSecretVault,
  unlockSecretVault,
  verifySecretVaultPassword,
  writeSecretVaultExtraSecrets,
  writeSecretVaultSecrets,
} from "./local-secret-vault/lifecycle.js";
export {
  applySecretVaultToProcessEnv,
  stripManagedSecretsFromDotenvFile,
} from "./local-secret-vault/env.js";
