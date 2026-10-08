import { type Address, type Hex } from "viem";
import { VexError, ErrorCodes } from "../../errors.js";
import { getPrimaryEvmEntry, loadEvmKey } from "./inventory.js";

/**
 * Resolve the PRIMARY EVM wallet (inventory index 0) + its private key.
 *
 * Back-compat: callers without session-scoped wallet selection use the primary
 * entry. On a legacy install this is the single wallet migrated from the old
 * `wallet.address` config field (keystore in the fixed KEYSTORE_FILE).
 */
export async function requireWalletAndKeystore(): Promise<{ address: Address; privateKey: Hex }> {
  const entry = getPrimaryEvmEntry();
  if (!entry) {
    throw new VexError(
      ErrorCodes.WALLET_NOT_CONFIGURED,
      "No wallet configured.",
      "Configure a wallet in Vex setup.",
    );
  }
  return loadEvmKey(entry);
}
