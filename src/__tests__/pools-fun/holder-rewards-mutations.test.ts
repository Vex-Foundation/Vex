/**
 * The two holder-reward mutations at their two boundaries: WHAT THE CALL
 * RETURNED and WHAT THE RECEIPT PROVED.
 *
 * Three properties are worth a suite here, and each of them is a way a holder
 * could be told something false about their own money:
 *
 *   1. THE RETURN SHAPE IS MEASURED, NOT ASSUMED. Two distributor runtimes are
 *      live: one returns a single word from `claim()` and one returns two. A
 *      one-word return read as two would report a nonexistent paired leg, and a
 *      two-word return read as one would lose a real payout. The bytes decide,
 *      and a length that is neither refuses instead of guessing.
 *   2. A MISSING PAIRED WORD IS THE ABSENCE OF A LEG, NEVER A ZERO. `null` and
 *      `0n` are different statements about a wallet's money.
 *   3. THE DECODER DECLINES RATHER THAN GUESSING. Emitter pinning, exactly-one,
 *      and an account filter - the same rules the launch and creator-fee
 *      decoders apply, because a receipt that does not prove OUR payout must
 *      leave the row pending rather than confirm an invented amount.
 *
 * The returndata below is the bytes the live distributors actually answered
 * (`fixtures/live-captures/chain-holder-rewards-distributor-runtimes.json`), and
 * the receipt logs are REAL ENCODED events from the measured ABIs.
 */

import { describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import {
  decodePoolsHolderRewardClaim,
  decodePoolsRewardDistribution,
  POOLS_CALLER_BOUNTY_EVENT_ABI,
  POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI,
  POOLS_REWARD_CLAIMED_SINGLE_EVENT_ABI,
} from "@tools/pools-fun/holder-rewards/decode.js";
import {
  poolsDistributorRevertName,
  simulatePoolsHolderRewardsClaim,
  simulatePoolsRewardDistribute,
} from "@tools/pools-fun/holder-rewards/mutations.js";

import { captureResponse } from "./_captures.js";

const DISTRIBUTOR = getAddress("0x7b53d176E76F87D0ba5173b6e596aFEe717e6b0b");
const OTHER_CONTRACT = getAddress("0xd64C1f0f26b6f636520bC686f8E25cBA58082cFE");
const HOLDER = getAddress("0x329a795fd7037132a1ae0fc74b5bc3aa6458b44b");
const SOMEONE_ELSE = getAddress("0x491a5b3683c8caabc9a185f6659d8a7ff4d60de3");
const BLOCK = 54_491_219n;

interface RuntimeArtifact {
  readonly claimSimulations: {
    readonly both_mode_holder: { readonly returnData: Hex };
    readonly paired_mode_holder: { readonly returnData: Hex };
    readonly single_word_runtime_holder: { readonly returnData: Hex };
    readonly wallet_owed_nothing: { readonly revertData: Hex };
  };
}
const artifact = captureResponse("chain-holder-rewards-distributor-runtimes") as RuntimeArtifact;

/** A client whose `call` answers with exactly the bytes a live distributor sent. */
function clientReturning(data: Hex): PublicClient<Transport, Chain> {
  return { call: async () => ({ data }) } as unknown as PublicClient<Transport, Chain>;
}

/**
 * A client whose `call` reverts the way viem's does: a `CallExecutionError`
 * wrapping a cause that carries the raw four bytes. The nesting is the point -
 * the revert reader walks it rather than reading one known class.
 */
function clientReverting(revertData: Hex): PublicClient<Transport, Chain> {
  return {
    call: async () => {
      const inner = Object.assign(new Error("execution reverted"), { data: revertData });
      throw Object.assign(new Error("Execution reverted for an unknown reason."), { cause: inner });
    },
  } as unknown as PublicClient<Transport, Chain>;
}

function concreteTopics(topics: readonly (string | readonly string[] | null)[]): string[] {
  return topics.filter((topic): topic is string => typeof topic === "string");
}

function dualClaimLog(over: { account?: Address; amount?: bigint; amountPaired?: bigint; address?: Address } = {}) {
  const f = { account: HOLDER, amount: 21n, amountPaired: 7n, address: DISTRIBUTOR, ...over };
  return {
    address: f.address,
    topics: concreteTopics(
      encodeEventTopics({
        abi: [POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI],
        eventName: "RewardClaimed",
        args: { account: f.account },
      }),
    ),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [f.amount, f.amountPaired]),
  };
}

function singleClaimLog(over: { account?: Address; amount?: bigint; address?: Address } = {}) {
  const f = { account: HOLDER, amount: 21n, address: DISTRIBUTOR, ...over };
  return {
    address: f.address,
    topics: concreteTopics(
      encodeEventTopics({
        abi: [POOLS_REWARD_CLAIMED_SINGLE_EVENT_ABI],
        eventName: "RewardClaimed",
        args: { account: f.account },
      }),
    ),
    data: encodeAbiParameters([{ type: "uint256" }], [f.amount]),
  };
}

function bountyLog(over: { caller?: Address; amount?: bigint; address?: Address } = {}) {
  const f = { caller: HOLDER, amount: 1_468n, address: DISTRIBUTOR, ...over };
  return {
    address: f.address,
    topics: concreteTopics(
      encodeEventTopics({
        abi: [POOLS_CALLER_BOUNTY_EVENT_ABI],
        eventName: "CallerBounty",
        args: { caller: f.caller },
      }),
    ),
    data: encodeAbiParameters([{ type: "uint256" }], [f.amount]),
  };
}

describe("simulating claim() reads the runtime the bytes came from", () => {
  it("reports TWO legs when the distributor returned two words", async () => {
    const result = await simulatePoolsHolderRewardsClaim(
      clientReturning(artifact.claimSimulations.both_mode_holder.returnData),
      { account: HOLDER, distributor: DISTRIBUTOR, blockNumber: BLOCK },
    );
    expect(result.kind).toBe("would_pay");
    if (result.kind !== "would_pay") return;
    expect(result.returnWordCount).toBe(2);
    // The live both-mode claim: both legs non-zero, which is what a both-mode
    // distributor is FOR.
    expect(result.tokenAmountRaw).toBeGreaterThan(0n);
    expect(result.pairedAmountRaw).not.toBeNull();
    expect(result.pairedAmountRaw!).toBeGreaterThan(0n);
  });

  it("keeps a PROVEN ZERO on the token leg of a paired-mode claim", async () => {
    // The live paired-mode return is `[0, <real amount>]`. A zero here is a
    // proven amount and the leg still exists - collapsing it to "no leg" would
    // lose the fact that this claim pays the paired asset.
    const result = await simulatePoolsHolderRewardsClaim(
      clientReturning(artifact.claimSimulations.paired_mode_holder.returnData),
      { account: HOLDER, distributor: DISTRIBUTOR, blockNumber: BLOCK },
    );
    expect(result.kind).toBe("would_pay");
    if (result.kind !== "would_pay") return;
    expect(result.tokenAmountRaw).toBe(0n);
    expect(result.pairedAmountRaw).not.toBeNull();
    expect(result.pairedAmountRaw!).toBeGreaterThan(0n);
  });

  it("reports NO paired leg - null, never zero - when the runtime returned one word", async () => {
    const result = await simulatePoolsHolderRewardsClaim(
      clientReturning(artifact.claimSimulations.single_word_runtime_holder.returnData),
      { account: HOLDER, distributor: DISTRIBUTOR, blockNumber: BLOCK },
    );
    expect(result.kind).toBe("would_pay");
    if (result.kind !== "would_pay") return;
    expect(result.returnWordCount).toBe(1);
    expect(result.pairedAmountRaw).toBeNull();
    expect(result.pairedAmountRaw).not.toBe(0n);
  });

  it("refuses a return length neither runtime produces instead of guessing", async () => {
    const threeWords = `0x${"00".repeat(96)}` as Hex;
    const result = await simulatePoolsHolderRewardsClaim(clientReturning(threeWords), {
      account: HOLDER,
      distributor: DISTRIBUTOR,
      blockNumber: BLOCK,
    });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toContain("96 bytes");
    expect(result.reason).toContain("will not guess");
  });

  it("turns the measured NothingToClaim revert into a fact, not a failure", async () => {
    const result = await simulatePoolsHolderRewardsClaim(
      clientReverting(artifact.claimSimulations.wallet_owed_nothing.revertData),
      { account: HOLDER, distributor: DISTRIBUTOR, blockNumber: BLOCK },
    );
    expect(result.kind).toBe("nothing_to_claim");
  });

  it("keeps ExcludedAccount as its OWN outcome, not folded into nothing-to-claim", async () => {
    // An excluded address will never be paid; a wallet owed nothing today may be
    // owed something tomorrow. Telling the first it should wait is a lie.
    const result = await simulatePoolsHolderRewardsClaim(clientReverting("0xb7594bec"), {
      account: HOLDER,
      distributor: DISTRIBUTOR,
      blockNumber: BLOCK,
    });
    expect(result.kind).toBe("excluded");
  });

  it("never reports a transport failure as nothing to claim", async () => {
    const client = {
      call: async () => {
        throw Object.assign(new Error("HTTP request failed"), { shortMessage: "HTTP request failed" });
      },
    } as unknown as PublicClient<Transport, Chain>;
    const result = await simulatePoolsHolderRewardsClaim(client, {
      account: HOLDER,
      distributor: DISTRIBUTOR,
      blockNumber: BLOCK,
    });
    expect(result.kind).toBe("unavailable");
  });

  it("reads the revert bytes out of a nested viem cause chain", () => {
    const inner = Object.assign(new Error("reverted"), { data: "0x969bf728" });
    const outer = Object.assign(new Error("call failed"), { cause: inner });
    expect(poolsDistributorRevertName(outer)).toBe("NothingToClaim");
    expect(poolsDistributorRevertName(new Error("no data here"))).toBeNull();
  });
});

describe("simulating distribute() names its outputs only where a verified ABI does", () => {
  it("labels the four-word return as named", async () => {
    const fourWords = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [1n, 2n, 3n, 4n],
    );
    const result = await simulatePoolsRewardDistribute(clientReturning(fourWords), {
      account: HOLDER,
      distributor: DISTRIBUTOR,
      blockNumber: BLOCK,
    });
    expect(result.kind).toBe("would_distribute");
    if (result.kind !== "would_distribute") return;
    expect(result.named).toBe(true);
    expect(result.words).toEqual([1n, 2n, 3n, 4n]);
  });

  it("refuses to label the five-word return, whose members are NOT established", async () => {
    const fiveWords = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [1n, 2n, 3n, 4n, 5n],
    );
    const result = await simulatePoolsRewardDistribute(clientReturning(fiveWords), {
      account: HOLDER,
      distributor: DISTRIBUTOR,
      blockNumber: BLOCK,
    });
    expect(result.kind).toBe("would_distribute");
    if (result.kind !== "would_distribute") return;
    expect(result.named).toBe(false);
    expect(result.words).toHaveLength(5);
  });

  it("treats NothingToDistribute as a fact about the pool", async () => {
    const result = await simulatePoolsRewardDistribute(clientReverting("0x01663f24"), {
      account: HOLDER,
      distributor: DISTRIBUTOR,
      blockNumber: BLOCK,
    });
    expect(result.kind).toBe("nothing_to_distribute");
  });
});

describe("the claim decoder proves the payout is OURS or declines", () => {
  it("decodes the two-leg event the newer runtime emits", () => {
    const result = decodePoolsHolderRewardClaim([dualClaimLog()], {
      account: HOLDER,
      distributor: DISTRIBUTOR,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shape).toBe("dual");
    expect(result.value.tokenAmountRaw).toBe(21n);
    expect(result.value.pairedAmountRaw).toBe(7n);
  });

  it("decodes the one-leg event with a NULL paired amount, not a zero", () => {
    const result = decodePoolsHolderRewardClaim([singleClaimLog()], {
      account: HOLDER,
      distributor: DISTRIBUTOR,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shape).toBe("single");
    expect(result.value.pairedAmountRaw).toBeNull();
  });

  it("decodes a proven ZERO payout as a success", () => {
    // A claim that paid nothing is a real settlement the receipt proved. Failing
    // here would leave the row pending forever for an amount that already exists.
    const result = decodePoolsHolderRewardClaim(
      [dualClaimLog({ amount: 0n, amountPaired: 0n })],
      { account: HOLDER, distributor: DISTRIBUTOR },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokenAmountRaw).toBe(0n);
  });

  it("IGNORES a same-signature event from any other contract in the receipt", () => {
    // Emitter pinning. Without it an arbitrary contract could have its event read
    // as the user's payout.
    const result = decodePoolsHolderRewardClaim(
      [dualClaimLog({ address: OTHER_CONTRACT, amount: 999n })],
      { account: HOLDER, distributor: DISTRIBUTOR },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no RewardClaimed event from the pinned distributor");
  });

  it("declines a receipt whose claim was paid to somebody else", () => {
    const result = decodePoolsHolderRewardClaim([dualClaimLog({ account: SOMEONE_ELSE })], {
      account: HOLDER,
      distributor: DISTRIBUTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("none paid to");
  });

  it("declines TWO claims for the same account rather than picking one", () => {
    const result = decodePoolsHolderRewardClaim([dualClaimLog(), dualClaimLog({ amount: 5n })], {
      account: HOLDER,
      distributor: DISTRIBUTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("cannot be attributed to a single claim row");
  });

  it("declines when ONE distributor emitted both shapes, which no measured runtime does", () => {
    const result = decodePoolsHolderRewardClaim([dualClaimLog(), singleClaimLog()], {
      account: HOLDER,
      distributor: DISTRIBUTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("BOTH RewardClaimed shapes");
  });
});

describe("the distribute decoder reports the bounty and never demands one", () => {
  it("succeeds with a NULL bounty when the distributor declared none", () => {
    // The ordinary outcome: the bounty comes out of the buyback, so a distribute
    // that bought nothing back pays nothing. Absence must not look like failure.
    const result = decodePoolsRewardDistribution([], { caller: HOLDER, distributor: DISTRIBUTOR });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bountyAmountRaw).toBeNull();
  });

  it("reports the amount the distributor declared for THIS caller", () => {
    const result = decodePoolsRewardDistribution([bountyLog({ amount: 1_468n })], {
      caller: HOLDER,
      distributor: DISTRIBUTOR,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bountyAmountRaw).toBe(1_468n);
  });

  it("ignores a bounty paid to someone else in the same transaction", () => {
    const result = decodePoolsRewardDistribution([bountyLog({ caller: SOMEONE_ELSE })], {
      caller: HOLDER,
      distributor: DISTRIBUTOR,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bountyAmountRaw).toBeNull();
  });

  it("ignores a bounty event from another contract", () => {
    const result = decodePoolsRewardDistribution([bountyLog({ address: OTHER_CONTRACT })], {
      caller: HOLDER,
      distributor: DISTRIBUTOR,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bountyAmountRaw).toBeNull();
  });

  it("declines TWO bounties for one caller rather than choosing an amount", () => {
    const result = decodePoolsRewardDistribution([bountyLog(), bountyLog({ amount: 9n })], {
      caller: HOLDER,
      distributor: DISTRIBUTOR,
    });
    expect(result.ok).toBe(false);
  });
});
