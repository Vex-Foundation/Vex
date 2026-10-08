import { Keypair } from "@solana/web3.js";
import { autoBackup } from "./backup.js";
import { registerPrimaryLegacyWallet } from "./inventory.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { requireKeystorePassword } from "../../utils/env.js";
import { deriveSolanaAddress, encryptSolanaSecretKey, saveSolanaKeystore, solanaKeystoreExists } from "./solana-keystore.js";

export interface SolanaWalletCreateResult {
  address: string;
  overwritten: boolean;
}

export async function createSolanaWallet(opts: { force?: boolean } = {}): Promise<SolanaWalletCreateResult> {
  const existed = solanaKeystoreExists();

  if (existed && !opts.force) {
    throw new VexError(
      ErrorCodes.KEYSTORE_ALREADY_EXISTS,
      "Solana keystore already exists.",
      "Use --force to overwrite. Existing keystore will be backed up automatically.",
    );
  }

  if (opts.force && existed) {
    await autoBackup();
  }

  const password = requireKeystorePassword();
  const keypair = Keypair.generate();
  const address = deriveSolanaAddress(keypair.secretKey);

  const keystore = await encryptSolanaSecretKey(keypair.secretKey, password);

  // The derive above yields to the event loop. If no keystore existed when this
  // call started but one exists now, a concurrent create/import wrote it while
  // we were deriving: refuse exactly as the up-front check would have, so a
  // non-forced call can never overwrite (or skip the backup of) a keystore.
  if (!existed && solanaKeystoreExists()) {
    throw new VexError(
      ErrorCodes.KEYSTORE_ALREADY_EXISTS,
      "Solana keystore already exists.",
      "Use --force to overwrite. Existing keystore will be backed up automatically.",
    );
  }
  saveSolanaKeystore(keystore);
  registerPrimaryLegacyWallet("solana", address);

  return { address, overwritten: existed };
}
