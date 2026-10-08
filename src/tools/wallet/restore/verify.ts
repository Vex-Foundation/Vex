/**
 * Decrypt/verify wallet material for restore (crypto-sensitive: private keys).
 *
 * Phase 1 (VALIDATE) decrypt stage: for every keystore file in the manifest,
 * decrypts the key with the supplied password and confirms the derived address
 * matches the address recorded in the backup. Wrong password →
 * KEYSTORE_DECRYPT_FAILED (raised by the keystore decrypt path) and STOP.
 * Address mismatch → SIGNER_MISMATCH (Class A, always hard fail — NEVER
 * consults confirmReplace). No writes happen here.
 *
 * Engine/main only — never imported by the renderer. Throws `VexError`.
 */

import { join } from "node:path";

import { privateKeyToAddress } from "viem/accounts";

import { isValidWalletId } from "../../../config/store.js";
import { VexError, ErrorCodes } from "../../../errors.js";
import {
  decryptPrivateKey,
  loadKeystoreFile,
  type KeystoreV1,
} from "../keystore.js";
import { decryptSolanaSecretKey, deriveSolanaAddress } from "../solana-keystore.js";
import {
  derivePath,
  walletAddressesEqual,
  type InventoryFamily,
} from "../inventory.js";
import {
  rejectMalformed,
  type ManifestWallet,
  type ValidatedManifest,
} from "./manifest.js";

/** A validated, decrypt-verified keystore file ready to write to its live path. */
export interface ValidatedWallet {
  readonly family: InventoryFamily;
  readonly legacy: boolean;
  readonly id: string;
  readonly address: string;
  readonly label: string;
  readonly createdAt: string;
  readonly stagedFilename: string;
  readonly livePath: string;
}

export async function deriveAddressFromKeystore(
  family: InventoryFamily,
  keystore: KeystoreV1,
  password: string,
): Promise<string> {
  if (family === "evm") {
    const privateKey = await decryptPrivateKey(keystore, password);
    return privateKeyToAddress(privateKey);
  }
  const secretKey = await decryptSolanaSecretKey(keystore, password);
  try {
    return deriveSolanaAddress(secretKey);
  } finally {
    secretKey.fill(0);
  }
}

/**
 * Decrypt-verify every keystore referenced by the manifest and produce the
 * ValidatedWallet list used by staging + commit. See module header for the
 * fail-closed contract.
 */
export async function verifyKeystores(
  manifest: ValidatedManifest,
  resolved: string,
  password: string,
  walletsById: Map<string, ManifestWallet>,
): Promise<ValidatedWallet[]> {
  // 5. Decrypt-verify every keystore. Wrong password → KEYSTORE_DECRYPT_FAILED
  //    and STOP. Address mismatch → SIGNER_MISMATCH (Class A, always hard fail).
  //    Files are verified one at a time, in manifest order, so the first
  //    failure stops the loop exactly as the synchronous version did.
  const validatedWallets: ValidatedWallet[] = [];
  for (const file of manifest.files) {
    if (
      file.role !== "wallet-evm" &&
      file.role !== "wallet-solana" &&
      file.role !== "legacy-evm" &&
      file.role !== "legacy-solana"
    ) {
      continue;
    }
    const family: InventoryFamily =
      file.role === "wallet-solana" || file.role === "legacy-solana" ? "solana" : "evm";
    const legacy = file.role === "legacy-evm" || file.role === "legacy-solana";

    // The wallets[] entry that owns this file.
    const wallet = legacy
      ? manifest.wallets.find((w) => w.family === family && w.legacy === true)
      : walletsById.get(file.walletId ?? "");
    if (!wallet) {
      rejectMalformed(`No wallets[] entry for ${file.role} file ${file.filename}.`);
    }
    if (legacy && !isValidWalletId(family, wallet.id, true)) {
      rejectMalformed(`Legacy ${family} wallet has a non-canonical id ${wallet.id}.`);
    }

    const p = join(resolved, file.filename);
    const keystore = loadKeystoreFile(p);
    if (!keystore) {
      // existence was checked above; a null here means an unreadable shape.
      rejectMalformed(`Keystore ${file.filename} could not be read.`);
    }

    const derived = await deriveAddressFromKeystore(family, keystore, password);
    if (!walletAddressesEqual(family, derived, wallet.address)) {
      // Class A: NEVER consult confirmReplace. The archive claims an address
      // the key does not produce — refuse outright.
      throw new VexError(
        ErrorCodes.SIGNER_MISMATCH,
        `Decrypted ${family} key does not match the address recorded in the backup.`,
        "The backup archive is inconsistent and was not restored.",
      );
    }

    validatedWallets.push({
      family,
      legacy,
      id: wallet.id,
      address: wallet.address,
      label: wallet.label,
      createdAt: wallet.createdAt,
      stagedFilename: file.filename,
      livePath: derivePath(family, {
        id: wallet.id,
        address: wallet.address,
        label: wallet.label,
        createdAt: wallet.createdAt,
        ...(legacy ? { legacy: true } : {}),
      }),
    });
  }

  return validatedWallets;
}
