/**
 * Wallet restore-from-backup (M8). The user picks a `.json` keystore
 * file via the Electron dialog (filtered to .json), main verifies the password
 * decrypts the file, confirms an address-mismatch overwrite if any,
 * backs up the current state, then atomically copies the keystore
 * into the canonical CONFIG_DIR location.
 *
 * Order (codex turn 8 YELLOW #4): validate → decrypt → derive →
 * mismatch confirmation → backup → atomic copy → config update.
 * Bad files / wrong passwords NEVER trigger a backup (no churn).
 *
 * The primitive itself does NOT call any Electron API. The caller
 * passes `confirmReplace`, a function the IPC handler implements with
 * `dialog.showMessageBox`. This keeps the primitive unit-testable.
 */

import { promises as fs } from "node:fs";
import { Keypair } from "@solana/web3.js";
import {
  autoBackup,
  decryptPrivateKey,
  decryptSolanaSecretKey,
  getPrimaryEvmAddress,
  getPrimarySolanaAddress,
  KEYSTORE_FILE,
  loadKeystoreFile,
  privateKeyToAddress,
  registerPrimaryLegacyWallet,
  saveKeystoreFile,
  SOLANA_KEYSTORE_FILE,
  type KeystoreV1,
} from "@vex-lib/wallet.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import type {
  WalletChain,
  WalletRestoreResult,
} from "@shared/schemas/wallets.js";
import { log } from "../logger/index.js";
import { mapWalletEngineError } from "./wallets-runner.js";

export interface RestoreArgs {
  readonly chain: WalletChain;
  readonly sourcePath: string;
  readonly password: string;
  /**
   * Called when an existing keystore for this chain has a derived
   * address that differs from the incoming one. Return `true` to
   * proceed with the overwrite, `false` to abort with
   * `wallet.user_rejected`. The IPC handler wires this to
   * `dialog.showMessageBox`.
   */
  readonly confirmReplace: (args: {
    readonly chain: WalletChain;
    readonly existingAddress: string;
    readonly incomingAddress: string;
  }) => Promise<boolean>;
}

function targetKeystorePath(chain: WalletChain): string {
  return chain === "evm" ? KEYSTORE_FILE : SOLANA_KEYSTORE_FILE;
}

function existingAddressFor(chain: WalletChain): string | null {
  return chain === "evm" ? getPrimaryEvmAddress() : getPrimarySolanaAddress();
}

async function readSourceKeystore(
  sourcePath: string
): Promise<Result<KeystoreV1, VexError>> {
  // Existence + readability first — gives a clearer error than
  // loadKeystoreFile's generic KEYSTORE_CORRUPT for ENOENT.
  try {
    await fs.access(sourcePath);
  } catch {
    return err({
      code: "validation.invalid_input",
      domain: "onboarding",
      message: "File not found.",
      retryable: false,
      userActionable: true,
      redacted: true,
    });
  }
  try {
    const ks = loadKeystoreFile(sourcePath);
    if (ks === null) {
      // loadKeystoreFile returns null only when path doesn't exist; we
      // already covered that above. Defensive branch.
      return err({
        code: "validation.invalid_input",
        domain: "onboarding",
        message: "File not found.",
        retryable: false,
        userActionable: true,
        redacted: true,
      });
    }
    return ok(ks);
  } catch (cause) {
    return mapWalletEngineError(cause);
  }
}

async function deriveAddress(
  chain: WalletChain,
  keystore: KeystoreV1,
  password: string
): Promise<Result<string, VexError>> {
  try {
    if (chain === "evm") {
      // EVM: decrypted private key is a hex string (immutable in JS).
      // We can't zeroize it; let GC collect once the function returns.
      const privateKey = await decryptPrivateKey(keystore, password);
      return ok(privateKeyToAddress(privateKey));
    }
    // Solana: decrypted secret is a Uint8Array — best-effort memory
    // hygiene per SKILL §8 + codex turn 9 STILL-OPEN. Zeroize after
    // address derivation so the bytes don't linger in main process
    // memory pages waiting for GC.
    const secretKey = await decryptSolanaSecretKey(keystore, password);
    try {
      const address = Keypair.fromSecretKey(secretKey).publicKey.toBase58();
      return ok(address);
    } finally {
      secretKey.fill(0);
    }
  } catch (cause) {
    // decryptPrivateKey/decryptSolanaSecretKey throw VexError
    // KEYSTORE_DECRYPT_FAILED on wrong password — mapWalletEngineError
    // maps to wallet.password_invalid.
    return mapWalletEngineError(cause);
  }
}

async function copyKeystoreAtomically(
  source: KeystoreV1,
  targetPath: string
): Promise<Result<true, VexError>> {
  try {
    saveKeystoreFile(targetPath, source);
    return ok(true);
  } catch (cause) {
    log.error(
      `[wallet-restore] atomic copy to ${targetPath} failed`,
      cause
    );
    return err({
      code: "onboarding.env_persist_failed",
      domain: "onboarding",
      message: "Failed to write the restored keystore. Check disk space and permissions.",
      retryable: true,
      userActionable: true,
      redacted: true,
    });
  }
}

function persistAddress(
  chain: WalletChain,
  address: string
): Result<true, VexError> {
  try {
    // Restored keystores land in the fixed legacy files, so register the
    // address as the primary legacy inventory entry (stage 1 multi-wallet).
    registerPrimaryLegacyWallet(chain === "evm" ? "evm" : "solana", address);
    return ok(true);
  } catch (cause) {
    log.error(`[wallet-restore] config write failed`, cause);
    return err({
      code: "onboarding.env_persist_failed",
      domain: "onboarding",
      message: "Failed to update wallet config.",
      retryable: true,
      userActionable: true,
      redacted: true,
    });
  }
}

export async function restoreWalletFromFile(
  args: RestoreArgs
): Promise<Result<WalletRestoreResult>> {
  // 1. Validate source file (exists, parses, has KeystoreV1 shape).
  const sourceResult = await readSourceKeystore(args.sourcePath);
  if (!sourceResult.ok) return sourceResult;
  const sourceKeystore = sourceResult.data;

  // 2. Decrypt + derive address (verifies password against source file).
  const addressResult = await deriveAddress(
    args.chain,
    sourceKeystore,
    args.password
  );
  if (!addressResult.ok) return addressResult;
  const incomingAddress = addressResult.data;

  // 3. Mismatch confirmation — only when an EXISTING different address
  //    is on disk for this chain. First-time restore (no existing) and
  //    same-address re-restore (idempotent) skip the prompt.
  const replacedAddress = existingAddressFor(args.chain);
  if (replacedAddress !== null && replacedAddress !== incomingAddress) {
    let proceed: boolean;
    try {
      proceed = await args.confirmReplace({
        chain: args.chain,
        existingAddress: replacedAddress,
        incomingAddress,
      });
    } catch (cause) {
      log.error(`[wallet-restore] confirmReplace threw`, cause);
      proceed = false;
    }
    if (!proceed) {
      return err({
        code: "wallet.user_rejected",
        domain: "wallet",
        message: "Restore cancelled — existing wallet was not replaced.",
        retryable: false,
        userActionable: false,
        redacted: true,
      });
    }
  }

  // 4. Backup current state BEFORE overwriting. autoBackup returns null
  //    when nothing exists to back up (first-time restore), which is
  //    correctly nullable in the result schema.
  let backupDir: string | null = null;
  try {
    backupDir = await autoBackup();
  } catch (cause) {
    return mapWalletEngineError(cause);
  }

  // 5. Atomic copy keystore into the canonical location (mode 0o600
  //    on POSIX via saveKeystoreFile).
  const copyResult = await copyKeystoreAtomically(
    sourceKeystore,
    targetKeystorePath(args.chain)
  );
  if (!copyResult.ok) return copyResult;

  // 6. Persist the derived address into config.json (atomic).
  const persistResult = persistAddress(args.chain, incomingAddress);
  if (!persistResult.ok) return persistResult;

  log.info(
    `[wallet-restore] chain=${args.chain} replaced=${replacedAddress ?? "<none>"} ` +
      `incoming=${incomingAddress} backupDir=${backupDir ?? "<none>"}`
  );

  return ok({
    chain: args.chain,
    address: incomingAddress,
    replacedAddress,
    backupDir,
  });
}
