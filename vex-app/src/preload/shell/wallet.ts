import { z } from "zod";
import { CH } from "../../shared/ipc/channels.js";
import { walletRemovalInputSchema, walletRecoveryInputSchema, walletExportPrivateKeyInputSchema } from "../../shared/schemas/wallets.js";
import type { WalletRemovalInput, WalletRecoveryInput, WalletExportPrivateKeyInput } from "../../shared/schemas/wallets.js";
import type { WalletBridge } from "../../shared/types/bridge/shell/wallet.js";
import { invokeWithSchema } from "../_dispatch.js";

export const wallet = {
  remove(input: WalletRemovalInput) { return invokeWithSchema(CH.wallet.remove, input, walletRemovalInputSchema); },
  restoreRemoved(input: WalletRecoveryInput) { return invokeWithSchema(CH.wallet.restoreRemoved, input, walletRecoveryInputSchema); },
  listRemoved() { return invokeWithSchema(CH.wallet.listRemoved, {}, z.object({}).strict()); },
  exportPrivateKey(input: WalletExportPrivateKeyInput) {
    return invokeWithSchema(
      CH.wallet.exportPrivateKey,
      input,
      walletExportPrivateKeyInputSchema
    );
  },
} satisfies WalletBridge;
