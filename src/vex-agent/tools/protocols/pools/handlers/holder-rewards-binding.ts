/**
 * WHICH DISTRIBUTOR, IN WHICH MODE, AND IS IT REALLY THIS TOKEN'S - the shared
 * authority resolution behind `pools.holder_rewards_claim` and
 * `pools.holder_rewards_distribute`.
 *
 * It exists as its own owner because both money tools ask exactly the same
 * question and must get exactly the same answer. Two copies of a
 * "find the distributor" walk is two chances to disagree about which contract a
 * transaction may be sent to, and the disagreement would only ever show up after
 * a signature.
 *
 * ── THE AUTHORITY TABLE (plan v3 section 2 A5, section 9 "A5 reward-mode
 *    authority"), verbatim, with where each row is enforced ────────────────
 *
 *   field        | authority                                   | enforced
 *   -------------|---------------------------------------------|--------------------
 *   chain        | Robinhood 4663 only                          | fixed by POOLS_CHAIN_ID
 *   token, suite | `readPoolsOnChainSnapshot` - registered on   | `resolve` below:
 *                | EXACTLY ONE suite; V1 has no holder rewards | four outcomes, no
 *                | at all; ambiguous/unavailable refuse by name| first-match
 *   distributor  | the `DistributorDeployed(token, distributor,| `readPoolsHolder
 *                | rewardMode)` log of THAT suite's deployer   | RewardsOnChain`
 *   mode         | the `rewardMode` ARGUMENT of that same log  | same log, same read
 *   binding      | `distributor.token()` == the token,         | `bindingViolations`
 *                | `.factory()` == the suite's factory,        |
 *                | `.locker()` == the suite's locker            |
 *   earned legs  | `earned(wallet)` and, where the runtime has | `read.ts`, one block
 *                | it, `earnedPaired(wallet)` at ONE block     |
 *   bounty       | `CALLER_BOUNTY_BPS()` on the distributor    | `readPoolsDistributor
 *                |                                             | Binding`
 *   API          | ECHO ONLY, on every row above                | never read here
 *
 * THE MODE IS THE EVENT'S ARGUMENT, NOT THE DISTRIBUTOR'S OPINION AND NOT THE
 * LAUNCHPAD'S. `distributor.rewardMode()` exists on one of the two live runtimes
 * and is treated as a second witness whose disagreement is reported; the
 * launchpad's `holderRewardsMode` is an echo `pools__holder_rewards_get`
 * displays. Only the deployer's own log decides.
 *
 * A BINDING VIOLATION IS A REFUSAL, NOT A WARNING. A distributor whose `token()`
 * is a different token, or whose `locker()` belongs to another suite, is not the
 * contract this token's suite deployed - and a claim sent there is a transaction
 * against a contract nobody verified.
 */

import { getAddress, type Address, type Chain, type PublicClient, type Transport } from "viem";

import {
  POOLS_CHAIN_ID,
  type PoolsContractSuite,
} from "@tools/pools-fun/constants.js";
import { readPoolsOnChainSnapshot } from "@tools/pools-fun/evm/token-registration.js";
import {
  readPoolsHolderRewardsOnChain,
  type PoolsHolderRewardMode,
  type PoolsRewardLeg,
} from "@tools/pools-fun/holder-rewards/read.js";
import { readPoolsDistributorBinding } from "@tools/pools-fun/holder-rewards/mutations.js";

/**
 * SUITES WHOSE `DistributorDeployed` REGISTRY IS EMPTY, so an absent event there
 * proves NOTHING about the token.
 *
 * MEASURED 2026-09-04 on chain 4663, and it is the reason this constant exists
 * rather than a comment:
 *
 *   - the V2 suite's `holderRewardsDeployer` `0x2da890c5...` has emitted
 *     `DistributorDeployed` ZERO times, ever;
 *   - the V2 FACTORY `0x80709b90...` has emitted `HolderRewardsEnabled(token,
 *     distributor)` THIRTEEN times, and `0x25ff1A3D...` - a live distributor
 *     that pays real rewards - answers `factory() = 0x80709b90...`;
 *   - the V3 deployer `0x5aeE24bD...` does emit `DistributorDeployed`, so V3 is
 *     unaffected.
 *
 * WHY THIS REFUSES INSTEAD OF WIDENING THE AUTHORITY. `HolderRewardsEnabled`
 * carries NO reward mode, and the reward mode is the field that decides which
 * assets a claim pays. Reading the distributor from the factory would therefore
 * mean sourcing the mode from somewhere the approved authority table does not
 * name (plan v3 section 9: "Mode authority = the `DistributorDeployed` event
 * from the suite's known deployer"), which is a change to a money-path authority
 * and belongs to the coordinator, not to this handler.
 *
 * WHY IT MUST NOT STAY SILENT EITHER. Without this arm, every V2
 * fees-to-holders token answers `no_holder_rewards`, whose sentence asserts that
 * the token "does not stream fees to holders" and never will. That assertion is
 * FALSE for those thirteen tokens, and it is false on the money path, in the
 * direction that tells a holder their rewards do not exist. Rule 00: when the
 * evidence does not support either statement, take the safer one and say what
 * was actually established.
 */
const SUITES_WITHOUT_A_DISTRIBUTOR_DEPLOYED_REGISTRY: readonly PoolsContractSuite["version"][] = [2];

/** Everything a holder-rewards mutation is allowed to act on, all from one block. */
export interface PoolsHolderRewardsBinding {
  readonly suite: PoolsContractSuite;
  readonly blockNumber: bigint;
  readonly deployer: Address;
  readonly distributor: Address;
  /** From the deployer's event. THE mode authority. `null` for an ordinal this build does not know. */
  readonly rewardMode: PoolsHolderRewardMode | null;
  readonly rewardModeWire: number;
  /** `distributor.rewardMode()` where the runtime has it. A second witness only. */
  readonly distributorSelfReportedMode: PoolsHolderRewardMode | null;
  /** The wallet the amounts were read for. */
  readonly wallet: Address;
  readonly tokenLeg: PoolsRewardLeg;
  /** `null` means this runtime has NO paired leg to read - not a zero balance. */
  readonly pairedLeg: PoolsRewardLeg | null;
  readonly walletExcluded: boolean | null;
  /** `CALLER_BOUNTY_BPS()`; `null` when this runtime has no bounty at all. */
  readonly bountyBps: number | null;
  readonly pairedAsset: Address | null;
  /** Facts that agree but are worth showing (a second-witness mode divergence). */
  readonly notes: readonly string[];
}

export type PoolsHolderRewardsBindingOutcome =
  | { readonly kind: "bound"; readonly binding: PoolsHolderRewardsBinding }
  /** The token is on a suite with no holder-rewards deployer at all (V1). A capability fact. */
  | { readonly kind: "unsupported_suite"; readonly suiteVersion: PoolsContractSuite["version"] }
  /** The suite's deployer emitted no event for this token: it does not stream fees to holders. */
  | {
      readonly kind: "no_holder_rewards";
      readonly suiteVersion: PoolsContractSuite["version"];
      readonly deployer: string;
    }
  /** Nothing may be signed, and the sentence says exactly what could not be established. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Resolve and BIND the distributor for one token, at one freshly-read block.
 *
 * Called once for the preview and AGAIN, from scratch, immediately before an
 * execute: the preview is the approval and the execute must prove the world
 * still matches it, which is impossible if the second read reuses the first
 * one's answers.
 */
export async function bindPoolsHolderRewards(
  client: PublicClient<Transport, Chain>,
  input: {
    readonly toolId: string;
    readonly token: Address;
    readonly wallet: Address;
  },
): Promise<PoolsHolderRewardsBindingOutcome> {
  // ── WHICH SUITE HOLDS THIS TOKEN ──────────────────────────────────
  //
  // Four outcomes, each with its own sentence, because "we could not ask" and
  // "there is nothing here" must never read alike on a money path.
  let snapshot;
  try {
    snapshot = await readPoolsOnChainSnapshot(input.token);
  } catch (err) {
    return {
      kind: "refused",
      reason:
        `${input.toolId} could not reach the chain to find which pools.fun suite holds ${input.token} `
        + `(${err instanceof Error ? err.name : "unknown error"}). Nothing was signed, and nothing about this `
        + "token's holder rewards was established either way.",
    };
  }
  const registration = snapshot.locker;
  if (registration.status === "unavailable") {
    return {
      kind: "refused",
      reason:
        `${input.toolId} could not determine which pools.fun suite holds ${input.token}: ${registration.detail} `
        + "Nothing was signed. Retry before concluding anything about this token's holder rewards.",
    };
  }
  if (registration.status === "ambiguous") {
    return {
      kind: "refused",
      reason:
        `${input.toolId} refuses to act on ${input.token}: ${registration.detail} Vex will not pick one suite to `
        + "read a distributor from when the chain does not agree which one owns the token. Nothing was signed.",
    };
  }
  if (registration.status === "unregistered") {
    return {
      kind: "refused",
      reason:
        `${input.toolId}: no pools.fun contract suite holds ${input.token}, so no suite has a holder-rewards `
        + "deployer that could have created a distributor for it. A token from another launchpad on this chain "
        + "keeps its rewards, if it has any, in its own contracts. Nothing was signed.",
    };
  }
  const suite = registration.suite;

  // ── THE DISTRIBUTOR AND ITS MODE, from the deployer's own event ────
  const onchain = await readPoolsHolderRewardsOnChain({
    token: input.token,
    wallet: input.wallet,
    suiteVersion: suite.version,
  });

  if (onchain.status === "suite_without_holder_rewards") {
    return { kind: "unsupported_suite", suiteVersion: onchain.suiteVersion };
  }
  if (onchain.status === "token_not_registered") {
    return {
      kind: "refused",
      reason:
        `${input.toolId}: the suite detector named V${suite.version} for ${input.token} while the holder-rewards `
        + "read found no registration at all. The two disagree, so nothing about this token was established and "
        + "nothing was signed.",
    };
  }
  if (onchain.status === "unavailable") {
    return {
      kind: "refused",
      reason:
        `${input.toolId} could not read this token's holder rewards: ${onchain.detail} Nothing was signed - this `
        + "is not a statement that there is nothing to claim.",
    };
  }
  if (onchain.status === "no_holder_rewards") {
    // An absent event only means "this token has no rewards" on a suite whose
    // deployer actually keeps that registry. On V2 it does not (see the constant
    // above), so the honest answer there is that nothing was established.
    if (SUITES_WITHOUT_A_DISTRIBUTOR_DEPLOYED_REGISTRY.includes(onchain.suiteVersion)) {
      return {
        kind: "refused",
        reason:
          `${input.toolId} cannot establish this token's holder rewards. It is registered on pools.fun suite `
          + `V${onchain.suiteVersion}, whose HolderRewardsDeployer ${onchain.deployer} has never emitted a `
          + "DistributorDeployed event for any token - that suite records its distributors on the FACTORY's "
          + "HolderRewardsEnabled event instead, which carries no reward mode. So an absent event here proves "
          + "nothing either way, and Vex will not tell you that a token pays its holders nothing on evidence "
          + "that cannot say so. Read the token with pools__token_get, and claim through the launchpad's own "
          + "interface for now. Nothing was signed.",
      };
    }
    return {
      kind: "no_holder_rewards",
      suiteVersion: onchain.suiteVersion,
      deployer: onchain.deployer,
    };
  }

  const distributor = getAddress(onchain.distributor);
  const blockNumber = BigInt(onchain.blockNumber);

  // ── IS THIS REALLY THIS TOKEN'S DISTRIBUTOR ───────────────────────
  let binding;
  try {
    binding = await readPoolsDistributorBinding(client, { distributor, blockNumber });
  } catch (err) {
    return {
      kind: "refused",
      reason:
        `${input.toolId} could not read the distributor ${distributor}'s own suite binding at block `
        + `${blockNumber} (${err instanceof Error ? err.name : "unknown error"}), so whether it belongs to this `
        + "token's suite is UNKNOWN. Nothing was signed.",
    };
  }

  const violations = bindingViolations({
    token: input.token,
    suite,
    distributor,
    distributorToken: onchain.distributorToken,
    distributorFactory: onchain.distributorFactory,
    distributorLocker: binding.locker,
  });
  if (violations.length > 0) {
    return {
      kind: "refused",
      reason:
        `${input.toolId} refuses to act on the distributor ${distributor}: it does not bind to the suite that `
        + `deployed it. ${violations.join(" ")} A contract that does not agree it belongs here is not one Vex `
        + "sends a transaction to. Nothing was signed.",
    };
  }

  const notes: string[] = [];
  if (
    onchain.distributorSelfReportedMode !== null
    && onchain.rewardMode !== null
    && onchain.distributorSelfReportedMode !== onchain.rewardMode
  ) {
    // NOT a refusal: the event is the authority and it answered. It IS shown,
    // because an agent quoting one mode while a claim pays the other is exactly
    // the confusion the authority table exists to end.
    notes.push(
      `The distributor's own rewardMode() says "${onchain.distributorSelfReportedMode}" while the deployer's `
        + `DistributorDeployed event recorded "${onchain.rewardMode}". The event is the authority and is what `
        + "every figure here follows.",
    );
  }
  if (onchain.rewardMode === null) {
    notes.push(
      `The deployer recorded reward mode ordinal ${onchain.rewardModeWire}, which this build has no name for. `
        + "The amounts below still come from the distributor itself, so they are what a claim would pay; only the "
        + "label is unknown.",
    );
  }

  return {
    kind: "bound",
    binding: {
      suite,
      blockNumber,
      deployer: getAddress(onchain.deployer),
      distributor,
      rewardMode: onchain.rewardMode,
      rewardModeWire: onchain.rewardModeWire,
      distributorSelfReportedMode: onchain.distributorSelfReportedMode,
      wallet: input.wallet,
      tokenLeg: onchain.tokenLeg,
      pairedLeg: onchain.pairedLeg,
      walletExcluded: onchain.walletExcluded,
      bountyBps: binding.bountyBps,
      pairedAsset: binding.pairedAsset,
      notes,
    },
  };
}

/**
 * Every way the distributor can fail to be this token's, each named.
 *
 * A call that DID NOT ANSWER is not a violation: the two live runtimes differ,
 * and holding a claim because a view is absent on one of them would refuse an
 * honest wallet its own money. What is refused is a call that answered with the
 * WRONG address - a positive statement that this contract belongs somewhere else.
 */
function bindingViolations(input: {
  readonly token: Address;
  readonly suite: PoolsContractSuite;
  readonly distributor: Address;
  readonly distributorToken: string | null;
  readonly distributorFactory: string | null;
  readonly distributorLocker: string | null;
}): string[] {
  const differs = (actual: string | null, expected: string): boolean => {
    if (actual === null) return false;
    try {
      return getAddress(actual) !== getAddress(expected);
    } catch {
      return true;
    }
  };
  const violations: string[] = [];
  if (differs(input.distributorToken, input.token)) {
    violations.push(
      `Its token() is ${input.distributorToken}, not ${input.token}: it streams a different token's fees.`,
    );
  }
  if (differs(input.distributorFactory, input.suite.factory)) {
    violations.push(
      `Its factory() is ${input.distributorFactory}, not suite V${input.suite.version}'s factory `
        + `${input.suite.factory}.`,
    );
  }
  if (differs(input.distributorLocker, input.suite.locker)) {
    violations.push(
      `Its locker() is ${input.distributorLocker}, not suite V${input.suite.version}'s locker `
        + `${input.suite.locker}.`,
    );
  }
  return violations;
}

/** The chain every holder-rewards mutation is pinned to. Never a parameter. */
export const POOLS_HOLDER_REWARDS_CHAIN_ID = POOLS_CHAIN_ID;
