/**
 * The sentences and shapes `pools.holder_rewards_claim` and
 * `pools.holder_rewards_distribute` must say IDENTICALLY.
 *
 * Both tools act on the same contract, refuse for the same reasons, and describe
 * the same distributor. Saying it twice is how two tools start describing one
 * contract differently - and on a money path the difference would only be
 * noticed by a user comparing two answers.
 */

import type { Address } from "viem";

import { POOLS_CHAIN_SLUG } from "@tools/pools-fun/constants.js";
import type { PoolsPrepareCrossCheck } from "@tools/pools-fun/holder-rewards/prepare-cross-check.js";

import { ok } from "../../handler-helpers.js";
import type { ToolResult } from "../../../types.js";
import type { PoolsHolderRewardsBinding } from "./holder-rewards-binding.js";

/** One leg a claim would pay, with everything needed to read it honestly. */
export interface PoolsRewardPayoutLeg {
  readonly side: "token" | "paired";
  readonly asset: Address;
  readonly symbol: string | null;
  /** `null` means the asset did not answer `decimals()`. Never assume 18. */
  readonly decimals: number | null;
  /** What the SIMULATION said this leg would pay, in base units. */
  readonly amountRaw: bigint;
  /** `earned`/`earnedPaired` at the same block - the accrual view, not the payout. */
  readonly earnedRaw: string;
}

/**
 * The distributor group every holder-rewards mutation reports, in the same shape
 * `pools__holder_rewards_get` uses so an agent reading both sees one contract.
 */
export function describeBoundDistributor(
  binding: PoolsHolderRewardsBinding,
): Record<string, unknown> {
  return {
    distributor: {
      address: binding.distributor,
      rewardMode: binding.rewardMode,
      ...(binding.rewardMode === null ? { rewardModeWire: binding.rewardModeWire } : {}),
      rewardModeAuthority:
        "the rewardMode argument of the DistributorDeployed event the suite's HolderRewardsDeployer emitted for "
        + "this token. Not the launchpad's row, and not the distributor's own rewardMode().",
      suite: { version: binding.suite.version, holderRewardsDeployer: binding.deployer },
      boundBy:
        "the distributor's own token(), factory() and locker() were read and agree with this token and this "
        + "suite; a distributor that disagreed would have been refused before anything else happened",
      pairedAsset: binding.pairedAsset,
      callerBountyBps: binding.bountyBps,
      walletExcluded: binding.walletExcluded,
    },
    blockNumber: binding.blockNumber.toString(),
    ...(binding.notes.length > 0 ? { distributorNotes: binding.notes } : {}),
  };
}

/**
 * The provider cross-check, projected so its four states cannot be misread as
 * two. `agrees` is corroboration, `declined` and `unavailable` are the ABSENCE
 * of corroboration, and `disagrees` never reaches here because it refuses first.
 */
export function describeCrossCheck(check: PoolsPrepareCrossCheck): Record<string, unknown> {
  if (check.status === "agrees") {
    return {
      status: "agrees",
      detail:
        `The launchpad's own POST /pools-fun/holder-rewards/prepare returned the same target (${check.providerTo}) `
        + `and the same calldata (${check.providerData}) Vex built from the distributor's verified ABI.`,
    };
  }
  if (check.status === "declined") {
    return {
      status: "declined",
      detail:
        `The launchpad had no calldata to offer for this request and said so (${check.detail}). That is the `
        + "provider's answer, not a disagreement about bytes - what a claim would pay is decided by the on-chain "
        + "simulation above, which does not need the launchpad at all.",
    };
  }
  if (check.status === "disagrees") {
    // Unreachable in practice - a disagreement refuses before any result is
    // built - and stated rather than assumed, so a future caller that forgets to
    // refuse first cannot render a disagreement as corroboration.
    return { status: "disagrees", differences: check.differences };
  }
  return {
    status: "unavailable",
    detail:
      `The launchpad's prepare endpoint did not answer (${check.detail}), so its calldata could not be compared `
      + "with ours. Nothing was learned either way. Every figure above still comes from the contracts, and the "
      + "target and calldata are Vex's own - the launchpad is corroboration here, never authority, which is why "
      + "its absence does not stop a self-custodial claim.",
  };
}

/** The token is on a suite that never had holder rewards at all. A capability fact. */
export function unsupportedSuiteResult(
  token: Address,
  suiteVersion: 1 | 2 | 3,
  action: "claim" | "distribute",
): ToolResult {
  return ok({
    chain: POOLS_CHAIN_SLUG,
    tokenAddress: token,
    status: "unsupported_on_this_suite",
    suite: { version: suiteVersion },
    [action === "claim" ? "claimed" : "distributed"]: false,
    detail:
      `This token is registered on pools.fun contract suite V${suiteVersion}, which has no HolderRewardsDeployer `
      + "at all: fees to holders did not exist yet when that suite was deployed. There is no distributor to "
      + `${action === "claim" ? "claim from" : "distribute for"} and none can appear, because the choice is `
      + "locked at launch. Nothing was signed.",
  });
}

/** The suite has a deployer, and it never deployed one for this token. Also a fact. */
export function noHolderRewardsResult(
  token: Address,
  suiteVersion: 1 | 2 | 3,
  deployer: string,
  action: "claim" | "distribute",
): ToolResult {
  return ok({
    chain: POOLS_CHAIN_SLUG,
    tokenAddress: token,
    status: "no_holder_rewards",
    suite: { version: suiteVersion, holderRewardsDeployer: deployer },
    [action === "claim" ? "claimed" : "distributed"]: false,
    detail:
      "This token does not stream fees to holders. The suite's HolderRewardsDeployer has emitted no "
      + "DistributorDeployed event for it, so there is no distributor and nothing to "
      + `${action === "claim" ? "claim" : "distribute"} - a fact about the token, not a failed read. Fees to `
      + "holders is opted into AT LAUNCH and cannot be turned on afterwards. Nothing was signed.",
  });
}
