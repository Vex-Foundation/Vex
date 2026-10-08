/**
 * Wallet generate/import runner (M8) — thin wrappers on the engine's
 * `createWallet`/`createSolanaWallet`/`importWallet`/`importSolanaWallet`
 * via the `@vex-lib/wallet.js` re-export. Returns `Result<T, VexError>`
 * envelopes mapped from engine `VexError` codes per codex turn 8 YELLOW
 * #5 — explicit per-error codes, no generic `onboarding.step_failed`.
 *
 * Callers (`ipc/onboarding/wallets.ts`) wrap each invocation in
 * `withWalletLock` (mutex) and `withFreshKeystorePassword` (force-fresh
 * password from `${CONFIG_DIR}/.env`).
 *
 * M8 explicitly REFUSES overwrite on generate/import: `force` is never
 * passed, so the engine throws `KEYSTORE_ALREADY_EXISTS` when a keystore
 * for that chain already exists. The mapping surfaces this as
 * `wallet.policy_blocked` with a user-actionable message pointing at
 * Restore as the recovery path.
 */

import {
  createEvmWalletEntry,
  createSolanaWallet,
  createSolanaWalletEntry,
  createWallet,
  exportAllWallets,
  importEvmWalletEntry,
  importSolanaWallet,
  importSolanaWalletEntry,
  importWallet,
} from "@vex-lib/wallet.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import type {
  WalletAddResult,
  WalletExportAllResult,
  WalletGenerateEvmResult,
  WalletGenerateSolanaResult,
  WalletImportEvmResult,
  WalletImportSolanaResult,
} from "@shared/schemas/wallets.js";
import { log } from "../logger/index.js";

// Engine VexError code constants (mirror src/errors.ts ErrorCodes). Inlined
// rather than imported so the re-export surface stays narrow.
const ENGINE_CODE = {
  KEYSTORE_ALREADY_EXISTS: "KEYSTORE_ALREADY_EXISTS",
  KEYSTORE_DECRYPT_FAILED: "KEYSTORE_DECRYPT_FAILED",
  KEYSTORE_PASSWORD_NOT_SET: "KEYSTORE_PASSWORD_NOT_SET",
  KEYSTORE_NOT_FOUND: "KEYSTORE_NOT_FOUND",
  KEYSTORE_CORRUPT: "KEYSTORE_CORRUPT",
  AUTO_BACKUP_FAILED: "AUTO_BACKUP_FAILED",
  INVALID_PRIVATE_KEY: "INVALID_PRIVATE_KEY",
  WALLET_INVENTORY_FULL: "WALLET_INVENTORY_FULL",
  WALLET_DUPLICATE_ADDRESS: "WALLET_DUPLICATE_ADDRESS",
  WALLET_USER_REJECTED: "WALLET_USER_REJECTED",
  AGENT_VALIDATION_ERROR: "AGENT_VALIDATION_ERROR",
  // Full-archive restore (C2). Mirrors src/errors.ts ErrorCodes.
  SIGNER_MISMATCH: "SIGNER_MISMATCH",
  ARCHIVE_MANIFEST_MALFORMED: "ARCHIVE_MANIFEST_MALFORMED",
  ARCHIVE_INCOMPLETE: "ARCHIVE_INCOMPLETE",
  ARCHIVE_RESTORE_FAILED: "ARCHIVE_RESTORE_FAILED",
} as const;

interface EngineErrorLike {
  readonly code: string;
  readonly message?: string;
}

function isEngineError(cause: unknown): cause is EngineErrorLike {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof (cause as { code: unknown }).code === "string"
  );
}

/**
 * Map engine errors to the public `VexError` surface. Anything we
 * don't explicitly recognise becomes `internal.unexpected` (NOT
 * `internal.contract_violation` — that is reserved for IPC handler
 * shape mismatches by registerHandler).
 */
export function mapWalletEngineError(cause: unknown): Result<never, VexError> {
  // normalizePrivateKey throws plain Error("Invalid private key: must be 32 bytes hex")
  if (cause instanceof Error && /Invalid private key/i.test(cause.message)) {
    return err({
      code: "validation.invalid_input",
      domain: "onboarding",
      message: "Invalid private key format.",
      retryable: false,
      userActionable: true,
      redacted: true,
    });
  }
  if (isEngineError(cause)) {
    switch (cause.code) {
      case ENGINE_CODE.KEYSTORE_ALREADY_EXISTS:
        return err({
          code: "wallet.policy_blocked",
          domain: "wallet",
          message:
            "A wallet already exists for this chain. Use Restore from backup to load a different one.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.KEYSTORE_DECRYPT_FAILED:
        return err({
          code: "wallet.password_invalid",
          domain: "wallet",
          message: "Wrong password or corrupted keystore.",
          retryable: true,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.KEYSTORE_PASSWORD_NOT_SET:
        return err({
          code: "wallet.password_invalid",
          domain: "wallet",
          message: "Master password not configured. Complete Step 1 first.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.KEYSTORE_NOT_FOUND:
        // Distinct from KEYSTORE_CORRUPT: file is absent vs present-but-bad.
        // Surface as `wallet.keystore_missing` so the renderer can route
        // the user to Generate / Import instead of Restore-from-backup.
        return err({
          code: "wallet.keystore_missing",
          domain: "wallet",
          message: "Keystore file is missing.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.KEYSTORE_CORRUPT:
        return err({
          code: "wallet.keystore_corrupt",
          domain: "wallet",
          message: "Keystore file is corrupted or in an unsupported format.",
          retryable: false,
          userActionable: false,
          redacted: true,
        });
      case ENGINE_CODE.AUTO_BACKUP_FAILED:
        return err({
          code: "onboarding.env_persist_failed",
          domain: "onboarding",
          message: "Failed to back up the existing wallet. Check disk space and permissions.",
          retryable: true,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.INVALID_PRIVATE_KEY:
        return err({
          code: "validation.invalid_input",
          domain: "onboarding",
          message: cause.message ?? "Invalid private key format.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.WALLET_INVENTORY_FULL:
        return err({
          code: "wallet.cap_reached",
          domain: "wallet",
          message: "Maximum of 3 wallets per chain reached. Remove one before adding another.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.WALLET_DUPLICATE_ADDRESS:
        return err({
          code: "wallet.address_exists",
          domain: "wallet",
          message: "This wallet address is already in your inventory.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      // ── Full-archive restore (C2) ─────────────────────────────────────────
      case ENGINE_CODE.SIGNER_MISMATCH:
        // The decrypted key does not derive the address recorded in the
        // backup manifest — the archive is untrustworthy. Never retry, never
        // overwrite. NOT user-actionable beyond "use a different backup".
        return err({
          code: "wallet.signer_mismatch",
          domain: "wallet",
          message:
            "Backup verification failed: a wallet key does not match its recorded address. This backup cannot be restored.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.ARCHIVE_INCOMPLETE:
        return err({
          code: "validation.archive_incomplete",
          domain: "onboarding",
          message:
            "Backup is incomplete: one or more files referenced by the manifest are missing.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.ARCHIVE_MANIFEST_MALFORMED:
        return err({
          code: "validation.archive_manifest_malformed",
          domain: "onboarding",
          message:
            "Backup manifest is malformed or in an unsupported format and cannot be restored.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.ARCHIVE_RESTORE_FAILED:
        // Catch-all for restore I/O / path-containment failures. Closest
        // existing public code; the manifest itself parsed but the restore
        // could not complete safely.
        return err({
          code: "validation.invalid_input",
          domain: "onboarding",
          message:
            "Backup could not be restored. The archive may be outside the backups folder or unreadable.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
      case ENGINE_CODE.WALLET_USER_REJECTED:
        return err({
          code: "wallet.user_rejected",
          domain: "wallet",
          message: "Restore cancelled.",
          retryable: false,
          userActionable: false,
          redacted: true,
        });
      case ENGINE_CODE.AGENT_VALIDATION_ERROR:
        return err({
          code: "validation.invalid_input",
          domain: "onboarding",
          message: cause.message ?? "Invalid wallet input.",
          retryable: false,
          userActionable: true,
          redacted: true,
        });
    }
  }
  log.error("[wallets-runner] unexpected engine error", cause);
  return err({
    code: "internal.unexpected",
    domain: "internal",
    message: "Unexpected error during wallet operation.",
    retryable: false,
    userActionable: false,
    redacted: true,
  });
}

export async function generateEvmWallet(): Promise<Result<WalletGenerateEvmResult>> {
  try {
    const result = await createWallet();
    return ok({ address: result.address });
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}

export async function generateSolanaWallet(): Promise<Result<WalletGenerateSolanaResult>> {
  try {
    const result = await createSolanaWallet();
    return ok({ address: result.address });
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}

export async function importEvmWallet(
  rawKey: string
): Promise<Result<WalletImportEvmResult>> {
  try {
    const result = await importWallet(rawKey);
    return ok({ address: result.address });
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}

export async function importSolanaWalletRunner(
  rawKey: string
): Promise<Result<WalletImportSolanaResult>> {
  try {
    const result = await importSolanaWallet(rawKey);
    return ok({ address: result.address });
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}

// ── Multi-wallet inventory runners (puzzle 5 phase 5D) ──────────────────────
// APPEND (not overwrite) up to MAX_WALLETS_PER_FAMILY. Cap/duplicate/label
// errors map to wallet.cap_reached / wallet.address_exists / validation.

export async function addEvmWallet(label?: string): Promise<Result<WalletAddResult>> {
  try {
    const e = await createEvmWalletEntry({ label });
    return ok({ id: e.id, address: e.address, label: e.label });
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}

export async function importEvmWalletInventory(
  rawKey: string,
  label?: string,
): Promise<Result<WalletAddResult>> {
  try {
    const e = await importEvmWalletEntry(rawKey, { label });
    return ok({ id: e.id, address: e.address, label: e.label });
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}

export async function addSolanaWallet(label?: string): Promise<Result<WalletAddResult>> {
  try {
    const e = await createSolanaWalletEntry({ label });
    return ok({ id: e.id, address: e.address, label: e.label });
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}

export async function importSolanaWalletInventory(
  rawKey: string,
  label?: string,
): Promise<Result<WalletAddResult>> {
  try {
    const e = await importSolanaWalletEntry(rawKey, { label });
    return ok({ id: e.id, address: e.address, label: e.label });
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}

export async function exportAllWalletsRunner(
  destDir: string,
): Promise<Result<WalletExportAllResult>> {
  try {
    const { files } = exportAllWallets(destDir);
    return ok({ files });
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}
