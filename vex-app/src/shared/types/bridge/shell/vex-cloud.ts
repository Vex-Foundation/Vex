import type { Result } from "../../../ipc/result.js";
import type {
  VexCloudAccountResult,
  VexCloudSignInInput,
  VexCloudSignInResult,
  VexCloudSignOutResult,
} from "../../../schemas/vex-cloud.js";
import type { AbortableInvocation } from "../common.js";

/**
 * Vex Cloud: sign-in and account, the renderer-facing half of the
 * `vex:vexCloud:*` channels.
 *
 * WHAT THIS INTERFACE DELIBERATELY DOES NOT OFFER: a message to sign, a
 * signature, a session bearer, a server URL or a destination. The renderer
 * names the wallets the user consented with; main does the signing against
 * the host it dials and keeps the bearer in the vault.
 */
export interface VexCloudBridge {
  /**
   * Sign in with every in-app EVM wallet in `wallets` (the set shown beside
   * the consent): creates the account, signs in, or links new wallets with a
   * co-signature from a linked one. Cancellable: `cancel()` stops before the
   * next step, and a session issued after the cancel is not stored.
   */
  readonly signIn: (input: VexCloudSignInInput) => AbortableInvocation<VexCloudSignInResult>;
  /** Balances, linked wallets and the rate; `signed_out` when no valid session exists. */
  readonly account: () => Promise<Result<VexCloudAccountResult>>;
  /** Remove the stored session. Idempotent. */
  readonly signOut: () => Promise<Result<VexCloudSignOutResult>>;
}
