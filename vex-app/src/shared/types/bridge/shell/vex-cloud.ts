import type { Result } from "../../../ipc/result.js";
import type {
  VexCloudAccountResult,
  VexCloudSignInInput,
  VexCloudSignInResult,
  VexCloudSignOutResult,
} from "../../../schemas/vex-cloud.js";
import type {
  VexCloudActivityResult,
  VexCloudClaimCashbackResult,
  VexCloudDepositProposal,
  VexCloudDepositsResult,
  VexCloudDepositWalletsResult,
  VexCloudPageInput,
  VexCloudPrepareDepositInput,
  VexCloudPrepareWithdrawalInput,
  VexCloudSubmitDepositInput,
  VexCloudSubmitDepositResult,
  VexCloudSubmitWithdrawalInput,
  VexCloudSubmitWithdrawalResult,
  VexCloudUsageResult,
  VexCloudWithdrawalProposal,
  VexCloudWithdrawalStatusInput,
} from "../../../schemas/vex-cloud-funding.js";
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

  // ── funding (phase 2) ──
  /** The in-app EVM wallets with their live VEX balance on Robinhood Chain. */
  readonly depositWallets: () => AbortableInvocation<VexCloudDepositWalletsResult>;
  /** Read fresh figures and mint a deposit proposal. Signs nothing. */
  readonly prepareDeposit: (input: VexCloudPrepareDepositInput) => AbortableInvocation<VexCloudDepositProposal>;
  /**
   * Sign and send the approved deposit. `cancel()` stops it only before the
   * signature; a sent transfer cannot be recalled.
   */
  readonly submitDeposit: (input: VexCloudSubmitDepositInput) => AbortableInvocation<VexCloudSubmitDepositResult>;
  /** Read fresh figures and mint a withdrawal proposal with its idempotency key. Sends nothing. */
  readonly prepareWithdrawal: (input: VexCloudPrepareWithdrawalInput) => AbortableInvocation<VexCloudWithdrawalProposal>;
  /** Ask Vex Cloud to send the approved withdrawal; a retry of the same proposal reuses its key. */
  readonly submitWithdrawal: (input: VexCloudSubmitWithdrawalInput) => Promise<Result<VexCloudSubmitWithdrawalResult>>;
  readonly withdrawal: (input: VexCloudWithdrawalStatusInput) => Promise<Result<VexCloudSubmitWithdrawalResult>>;
  /** Move all claimable cashback to the balance. */
  readonly claimCashback: () => Promise<Result<VexCloudClaimCashbackResult>>;
  readonly activity: (input: VexCloudPageInput) => Promise<Result<VexCloudActivityResult>>;
  readonly usage: (input: VexCloudPageInput) => Promise<Result<VexCloudUsageResult>>;
  readonly deposits: (input: VexCloudPageInput) => Promise<Result<VexCloudDepositsResult>>;
}
