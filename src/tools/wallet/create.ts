import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { loadConfig } from "../../config/store.js";
import { encryptPrivateKey, saveKeystore, keystoreExists } from "./keystore.js";
import { registerPrimaryLegacyWallet } from "./inventory.js";
import { autoBackup } from "./backup.js";
import { requireKeystorePassword } from "../../utils/env.js";
import { VexError, ErrorCodes } from "../../errors.js";

export interface WalletCreateResult {
  address: Address;
  chainId: number;
  overwritten: boolean;
}

/**
 * Core wallet creation logic.
 * Does NOT handle UI output — caller is responsible for display.
 * Does NOT check guardrails — caller must call assertWalletMutationAllowed() first.
 */
export async function createWallet(opts: { force?: boolean } = {}): Promise<WalletCreateResult> {
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
  const privateKey = generatePrivateKey();
  const address = privateKeyToAddress(privateKey);

  const keystore = encryptPrivateKey(privateKey, password);
  saveKeystore(keystore);

  registerPrimaryLegacyWallet("evm", address);

  return { address, chainId: loadConfig().chain.chainId, overwritten: existed };
}
