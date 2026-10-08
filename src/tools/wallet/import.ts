import type { Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { loadConfig } from "../../config/store.js";
import { encryptPrivateKey, saveKeystore, keystoreExists, normalizePrivateKey } from "./keystore.js";
import { registerPrimaryLegacyWallet } from "./inventory.js";
import { autoBackup } from "./backup.js";
import { requireKeystorePassword } from "../../utils/env.js";
import { VexError, ErrorCodes } from "../../errors.js";

export interface WalletImportResult {
  address: Address;
  chainId: number;
  overwritten: boolean;
}

/**
 * Core wallet import logic.
 * Does NOT handle UI output — caller is responsible for display.
 * Does NOT check guardrails — caller must call assertWalletMutationAllowed() first.
 */
export async function importWallet(
  rawKey: string,
  opts: { force?: boolean } = {}
): Promise<WalletImportResult> {
  // Validate key
  const normalizedKey = normalizePrivateKey(rawKey);

  const existed = keystoreExists();

  if (existed && !opts.force) {
    throw new VexError(
      ErrorCodes.KEYSTORE_ALREADY_EXISTS,
      "Keystore already exists.",
      "Use --force to overwrite. Existing keystore will be backed up automatically."
    );
  }

  if (opts.force && existed) {
    await autoBackup();
  }

  const password = requireKeystorePassword();

  const keystore = await encryptPrivateKey(normalizedKey, password);

  // The derive above yields to the event loop. If no keystore existed when this
  // call started but one exists now, a concurrent create/import wrote it while
  // we were deriving: refuse exactly as the up-front check would have, so a
  // non-forced call can never overwrite (or skip the backup of) a keystore.
  if (!existed && keystoreExists()) {
    throw new VexError(
      ErrorCodes.KEYSTORE_ALREADY_EXISTS,
      "Keystore already exists.",
      "Use --force to overwrite. Existing keystore will be backed up automatically."
    );
  }
  saveKeystore(keystore);

  const address = privateKeyToAddress(normalizedKey);
  registerPrimaryLegacyWallet("evm", address);

  return { address, chainId: loadConfig().chain.chainId, overwritten: existed };
}
