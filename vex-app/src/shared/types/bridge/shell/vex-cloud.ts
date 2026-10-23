import type { Result } from "../../../ipc/result.js";
import type {
  VexCloudAccountResult,
  VexCloudSignInInput,
  VexCloudSignInResult,
  VexCloudSignOutResult,
} from "../../../schemas/vex-cloud.js";
import type {
  VexCloudCancelWithdrawalInput,
  VexCloudCancelWithdrawalResult,
  VexCloudDismissWithdrawalNoticeInput,
  VexCloudDismissWithdrawalNoticeResult,
  VexCloudWithdrawalNoticesResult,
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
  VexCloudWithdrawalStatusResult,
} from "../../../schemas/vex-cloud-funding.js";
import type {
  VexCloudAlert,
  VexCloudAlertSetInput,
  VexCloudAutoTopUpGetResult,
  VexCloudAutoTopUpProposal,
  VexCloudPrepareAutoTopUpInput,
  VexCloudSubmitAutoTopUpInput,
  VexCloudSubmitAutoTopUpResult,
} from "../../../schemas/vex-cloud-auto-top-up.js";
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
  readonly withdrawal: (input: VexCloudWithdrawalStatusInput) => Promise<Result<VexCloudWithdrawalStatusResult>>;
  /**
   * Cancel a cooling withdrawal (its VEX returns to the balance). Main mints
   * the idempotency key; cancelling the same withdrawal again while the
   * first answer is unknown replays it ("Check status").
   */
  readonly cancelWithdrawal: (input: VexCloudCancelWithdrawalInput) => AbortableInvocation<VexCloudCancelWithdrawalResult>;
  /** Cooling withdrawals on the account that this app did not start. */
  readonly withdrawalNotices: () => AbortableInvocation<VexCloudWithdrawalNoticesResult>;
  /** "It was me": the notice does not return for this withdrawal. */
  readonly dismissWithdrawalNotice: (
    input: VexCloudDismissWithdrawalNoticeInput,
  ) => Promise<Result<VexCloudDismissWithdrawalNoticeResult>>;
  /** Move all claimable cashback to the balance. */
  readonly claimCashback: () => Promise<Result<VexCloudClaimCashbackResult>>;
  readonly activity: (input: VexCloudPageInput) => Promise<Result<VexCloudActivityResult>>;
  readonly usage: (input: VexCloudPageInput) => Promise<Result<VexCloudUsageResult>>;
  readonly deposits: (input: VexCloudPageInput) => Promise<Result<VexCloudDepositsResult>>;
  /** The low-balance alert percent and the last observation (balance, reference, threshold). */
  readonly alertGet: () => Promise<Result<VexCloudAlert>>;
  readonly alertSet: (input: VexCloudAlertSetInput) => Promise<Result<VexCloudAlert>>;
  /** The live auto top-up rule with its derived state, caps used and recent executions. */
  readonly autoTopUpGet: () => AbortableInvocation<VexCloudAutoTopUpGetResult>;
  /** Mint a rule-change proposal: every bound the rule will hold. Changes nothing. */
  readonly prepareAutoTopUp: (input: VexCloudPrepareAutoTopUpInput) => AbortableInvocation<VexCloudAutoTopUpProposal>;
  /** Apply the approved proposal (the card is the approval). Execution-gated. */
  readonly submitAutoTopUp: (input: VexCloudSubmitAutoTopUpInput) => Promise<Result<VexCloudSubmitAutoTopUpResult>>;
}
