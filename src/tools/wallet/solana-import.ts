import { autoBackup } from "./backup.js";
import { registerPrimaryLegacyWallet } from "./inventory.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { requireKeystorePassword } from "../../utils/env.js";
import {
  deriveSolanaAddress,
  encryptSolanaSecretKey,
  normalizeSolanaSecretKey,
  saveSolanaKeystore,
  solanaKeystoreExists,
} from "./solana-keystore.js";

export interface SolanaWalletImportResult {
  address: string;
  overwritten: boolean;
}

export async function importSolanaWallet(
  rawKey: string,
  opts: { force?: boolean } = {},
): Promise<SolanaWalletImportResult> {
  const normalizedKey = normalizeSolanaSecretKey(rawKey);
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
  const address = deriveSolanaAddress(normalizedKey);

  const keystore = await encryptSolanaSecretKey(normalizedKey, password);

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
