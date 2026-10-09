import type { Result } from "../../../ipc/result.js";
import type {
  WalletRemovalInput, WalletRecoveryInput, WalletRemovalResult, RemovedWallets,
  WalletExportPrivateKeyInput,
  WalletExportPrivateKeyResult,
} from "../../../schemas/wallets.js";

/**
 * Sudo-style wallet operations on existing keystores. Distinct from
 * `onboarding.wallet*` which create/import keystores during setup —
 * these run post-onboarding and require a fresh password challenge.
 */
export interface WalletBridge {
  readonly remove: (input: WalletRemovalInput) => Promise<Result<WalletRemovalResult>>;
  readonly restoreRemoved: (input: WalletRecoveryInput) => Promise<Result<WalletRemovalResult>>;
  readonly listRemoved: () => Promise<Result<RemovedWallets>>;
  /**
   * Re-authenticate the user, decrypt the chain's keystore inside
   * main, and place the raw private key on the OS clipboard with an
   * auto-clear lease. The renderer never sees the secret — the
   * Result only reports `copied: true` + how long until clipboard
   * is wiped. Triggers `wallet.export_throttled` (with retryAfterMs)
   * on rapid retries, and relocks the vault after 5 wrong-password
   * attempts in a single process lifetime.
   */
  readonly exportPrivateKey: (
    input: WalletExportPrivateKeyInput
  ) => Promise<Result<WalletExportPrivateKeyResult>>;
}
