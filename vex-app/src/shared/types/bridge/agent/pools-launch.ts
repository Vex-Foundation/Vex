import type { Result } from "../../../ipc/result.js";
import type {
  LaunchFormEvent,
  PoolsAwaitingFormCancelResult,
  PoolsClaimedFees,
  PoolsClaimInput,
  PoolsClaimPreview,
  PoolsDeployedLaunch,
  PoolsLaunchCancelAwaitingFormInput,
  PoolsLaunchCancelInput,
  PoolsLaunchCancelResult,
  PoolsLaunchDeployInput,
  PoolsLaunchGetAwaitingInput,
  PoolsLaunchGetAwaitingResult,
  PoolsLaunchMyLaunchesInput,
  PoolsLaunchMyLaunchesResult,
  PoolsLaunchPrepareInput,
  PoolsPreparedLaunch,
} from "../../../schemas/pools-launch.js";

/**
 * pools.fun launches and creator-fee claims — the renderer-facing half of the
 * `vex:poolsLaunch:*` channels.
 *
 * TWO STAGES, AND WHY THE SPLIT IS THE SAFETY PROPERTY. `prepare` uploads the
 * image, calls the gateway's prepare endpoint and runs the full calldata
 * verifier. It signs nothing. What it returns is the FINAL token address this
 * exact calldata produces, the RESOLVED fee recipient, and the costs leg by leg
 * — plus an opaque `fingerprintId` naming the verified calldata and value.
 * `deploy` takes only that id. The renderer therefore has no field with which to
 * alter a launch between the screen the user read and the signature, which is
 * what makes "the Deploy click authorizes exactly this" true rather than
 * aspirational.
 *
 * WHAT THIS INTERFACE DELIBERATELY DOES NOT OFFER: any fee, value, deadline, gas
 * or wallet-address input. The one recipient field is a LOGICAL choice the owner
 * gave the user on the manual form (address or X username, resolved and echoed
 * back for confirmation) — see the carve-out documented in
 * `schemas/pools-launch.ts`. It names who receives a future fee stream; it never
 * becomes a number in a transaction.
 *
 * `getAwaiting` answers `null` when nothing is waiting. That is the ordinary
 * state of a session, not a refusal.
 */
export interface PoolsLaunchBridge {
  /** STAGE 1: prepare and verify. Signs nothing, spends nothing. */
  readonly prepare: (
    input: PoolsLaunchPrepareInput,
  ) => Promise<Result<PoolsPreparedLaunch>>;
  /** STAGE 2: authorize exactly the fingerprint stage 1 returned. */
  readonly deploy: (
    input: PoolsLaunchDeployInput,
  ) => Promise<Result<PoolsDeployedLaunch>>;
  readonly cancel: (
    input: PoolsLaunchCancelInput,
  ) => Promise<Result<PoolsLaunchCancelResult>>;
  /**
   * The user DISMISSED the form an agent asked them to fill: end the draft and
   * wake the turn parked on it.
   *
   * A DIFFERENT OBJECT from `cancel` above. That one ends a PREPARED launch by
   * its verified fingerprint; this one ends an `awaiting_user_form` intent by
   * the `intentId` `getAwaiting` handed over, and is the only launch call that
   * can answer a parked agent. Neither signs, spends, or names an amount.
   */
  readonly cancelAwaitingForm: (
    input: PoolsLaunchCancelAwaitingFormInput,
  ) => Promise<Result<PoolsAwaitingFormCancelResult>>;
  readonly myLaunches: (
    input: PoolsLaunchMyLaunchesInput,
  ) => Promise<Result<PoolsLaunchMyLaunchesResult>>;
  readonly getAwaiting: (
    input: PoolsLaunchGetAwaitingInput,
  ) => Promise<Result<PoolsLaunchGetAwaitingResult>>;
  /**
   * Simulates `collectAndClaim` and reports BOTH payout legs. The locker's
   * `claimable*` mappings are NOT this number — they show what was already
   * collected, and presenting them as claimable reads as "nothing to claim".
   */
  readonly claimPreview: (
    input: PoolsClaimInput,
  ) => Promise<Result<PoolsClaimPreview>>;
  readonly claim: (input: PoolsClaimInput) => Promise<Result<PoolsClaimedFees>>;
  /**
   * Subscribe to `EV.launch.formRequested` - fired after an agent's
   * `pools.launch_request_form` intent has COMMITTED. The payload is an
   * INVALIDATION SIGNAL only: it carries ids, an enum and a timestamp, and the
   * renderer re-reads `getAwaiting` rather than reconstructing a draft from it.
   * Returns its own unsubscribe.
   */
  readonly onFormRequested: (cb: (event: LaunchFormEvent) => void) => () => void;
}
