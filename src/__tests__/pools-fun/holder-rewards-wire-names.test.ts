/**
 * EVERY WIRE NAME THIS LANE EMITS, PINNED TO A MACHINE ARTIFACT.
 *
 * Rule 10 point 2: "every enum member, field name and command shape the code
 * emits is read from the checked-in descriptor or schema artifact, and a table
 * test enumerates all of them against that artifact. Hand-spelled wire names are
 * a defect even when they happen to be correct."
 *
 * On this lane that is not a formality. The two live distributor runtimes emit
 * DIFFERENT `RewardClaimed` events and return DIFFERENT numbers of words from
 * `claim()` and `distribute()`, so a hand-spelled topic would decline every real
 * receipt from one of them - silently, after money had already moved. The
 * artifact these assert against
 * (`fixtures/live-captures/chain-holder-rewards-distributor-runtimes.json`) was
 * read out of live logs and `eth_call`s on chain 4663 and every signature in it
 * was then confirmed by keccak PREIMAGE.
 */

import { describe, it, expect } from "vitest";
import { encodeFunctionData, toEventSelector, toFunctionSelector } from "viem";

import {
  POOLS_CALLER_BOUNTY_TOPIC,
  POOLS_REWARD_CLAIMED_DUAL_TOPIC,
  POOLS_REWARD_CLAIMED_SINGLE_TOPIC,
  POOLS_CALLER_BOUNTY_EVENT_ABI,
  POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI,
  POOLS_REWARD_CLAIMED_SINGLE_EVENT_ABI,
} from "@tools/pools-fun/holder-rewards/decode.js";
import {
  POOLS_DISTRIBUTOR_BOUNTY_ABI,
  POOLS_DISTRIBUTOR_ERROR_ABI,
  POOLS_DISTRIBUTOR_ERROR_SELECTORS,
  POOLS_DISTRIBUTOR_LOCKER_ABI,
  poolsHolderRewardsClaimCalldata,
  poolsHolderRewardsDistributeCalldata,
} from "@tools/pools-fun/holder-rewards/mutations.js";

import { captureResponse } from "./_captures.js";

interface RuntimeArtifact {
  readonly selectors: Readonly<Record<string, string>>;
  readonly errorSelectors: Readonly<Record<string, string>>;
  readonly eventTopics: Readonly<Record<string, unknown>>;
  readonly runtimes: {
    readonly verified_13962: { readonly rewardClaimedTopic: string; readonly claimReturnWords: number };
    readonly extended_22171: {
      readonly rewardClaimedTopic: string;
      readonly claimReturnWords: number;
      readonly callerBountyBps: number;
    };
  };
}

const artifact = captureResponse("chain-holder-rewards-distributor-runtimes") as RuntimeArtifact;

describe("the calldata Vex signs is the calldata the chain answered to", () => {
  it("encodes claim() to the selector the live distributors dispatch on", () => {
    // Built from the ABI, compared against the four bytes measured live - a
    // constant typed here would only prove it matches itself.
    expect(poolsHolderRewardsClaimCalldata()).toBe(artifact.selectors["claim()"]);
  });

  it("encodes distribute() to the selector the provider's own prepare returns", () => {
    expect(poolsHolderRewardsDistributeCalldata()).toBe(artifact.selectors["distribute()"]);
  });

  it("takes NO arguments on either call, so neither can be pointed at an account", () => {
    // `claimFor(address)` exists on both runtimes and is deliberately unbuildable
    // here: a claim on the agent path pays whoever signs it, and calldata that
    // could name another account is the whole shape rule 90 forbids.
    expect(poolsHolderRewardsClaimCalldata()).toHaveLength(10);
    expect(poolsHolderRewardsDistributeCalldata()).toHaveLength(10);
  });

  it("reads locker() and CALLER_BOUNTY_BPS() at their measured selectors", () => {
    expect(toFunctionSelector(POOLS_DISTRIBUTOR_LOCKER_ABI[0])).toBe(artifact.selectors["locker()"]);
    expect(toFunctionSelector(POOLS_DISTRIBUTOR_BOUNTY_ABI[0]))
      .toBe(artifact.selectors["CALLER_BOUNTY_BPS()"]);
    expect(
      encodeFunctionData({ abi: POOLS_DISTRIBUTOR_BOUNTY_ABI, functionName: "CALLER_BOUNTY_BPS" }),
    ).toBe(artifact.selectors["CALLER_BOUNTY_BPS()"]);
  });
});

describe("every named revert this lane maps was read from the verified ABI", () => {
  it.each(Object.entries(artifact.errorSelectors))(
    "%s has selector %s and the table maps it back to that name",
    (signature, selector) => {
      const name = signature.replace("()", "");
      expect(POOLS_DISTRIBUTOR_ERROR_SELECTORS[selector]).toBe(name);
    },
  );

  it("maps NothingToClaim, which is the one an ordinary wallet meets", () => {
    // The measured revert of `claim()` from a wallet holding none of the token.
    // If this selector were wrong, "you are owed nothing" would arrive as
    // "the call failed" and a holder would be told their rewards were gone.
    expect(POOLS_DISTRIBUTOR_ERROR_SELECTORS["0x969bf728"]).toBe("NothingToClaim");
  });

  it("declares every mapped selector in the error ABI too", () => {
    const abiNames = new Set(POOLS_DISTRIBUTOR_ERROR_ABI.map((e) => e.name));
    for (const name of Object.values(POOLS_DISTRIBUTOR_ERROR_SELECTORS)) {
      expect(abiNames.has(name as never)).toBe(true);
    }
  });

  it("maps no selector the artifact does not carry", () => {
    // The reverse direction: an invented entry here would name a revert the
    // chain never answers with, and a decoder would report it as fact.
    const measured = new Set(Object.values(artifact.errorSelectors));
    for (const selector of Object.keys(POOLS_DISTRIBUTOR_ERROR_SELECTORS)) {
      expect(measured.has(selector)).toBe(true);
    }
  });
});

describe("both RewardClaimed shapes are pinned, because both are live", () => {
  it("derives the one-leg topic from its signature and matches the older runtime's logs", () => {
    expect(POOLS_REWARD_CLAIMED_SINGLE_TOPIC).toBe(toEventSelector("RewardClaimed(address,uint256)"));
    expect(POOLS_REWARD_CLAIMED_SINGLE_TOPIC).toBe(artifact.runtimes.verified_13962.rewardClaimedTopic);
    expect(POOLS_REWARD_CLAIMED_SINGLE_TOPIC)
      .toBe(artifact.eventTopics["RewardClaimed(address,uint256)"]);
  });

  it("derives the two-leg topic and matches the newer runtime's logs", () => {
    expect(POOLS_REWARD_CLAIMED_DUAL_TOPIC).toBe(toEventSelector("RewardClaimed(address,uint256,uint256)"));
    expect(POOLS_REWARD_CLAIMED_DUAL_TOPIC).toBe(artifact.runtimes.extended_22171.rewardClaimedTopic);
  });

  it("keeps them DIFFERENT, which is the whole reason both exist here", () => {
    expect(POOLS_REWARD_CLAIMED_SINGLE_TOPIC).not.toBe(POOLS_REWARD_CLAIMED_DUAL_TOPIC);
  });

  it("marks account as the indexed argument on both, matching the observed two-topic logs", () => {
    expect(POOLS_REWARD_CLAIMED_SINGLE_EVENT_ABI.inputs[0]).toMatchObject({ name: "account", indexed: true });
    expect(POOLS_REWARD_CLAIMED_SINGLE_EVENT_ABI.inputs[1]).toMatchObject({ indexed: false });
    expect(POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI.inputs[0]).toMatchObject({ name: "account", indexed: true });
    expect(POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI.inputs.filter((i) => i.indexed)).toHaveLength(1);
  });

  it("pins the caller-bounty topic, the only proof of what a distribute paid its caller", () => {
    expect(POOLS_CALLER_BOUNTY_TOPIC).toBe(toEventSelector("CallerBounty(address,uint256)"));
    expect(POOLS_CALLER_BOUNTY_TOPIC).toBe(artifact.eventTopics["CallerBounty(address,uint256)"]);
    expect(POOLS_CALLER_BOUNTY_EVENT_ABI.inputs[0]).toMatchObject({ name: "caller", indexed: true });
  });
});

describe("the artifact records what the two runtimes actually return", () => {
  it("keeps the one-word and two-word claim shapes as separate measured facts", () => {
    expect(artifact.runtimes.verified_13962.claimReturnWords).toBe(1);
    expect(artifact.runtimes.extended_22171.claimReturnWords).toBe(2);
  });

  it("records the caller bounty as a constant on the newer runtime only", () => {
    expect(artifact.runtimes.extended_22171.callerBountyBps).toBe(50);
    expect((artifact.runtimes.verified_13962 as { callerBountyBps?: unknown }).callerBountyBps).toBeNull();
  });
});
