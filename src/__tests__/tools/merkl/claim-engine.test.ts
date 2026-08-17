/**
 * The Merkl claim engine: which reward rows become leaves, what calldata they
 * build, and what the pre-signature assertion refuses.
 *
 * THE NUMBERS HERE ARE NOT INVENTED. Every amount, root and proof length comes
 * from the live Base capture of 2026-08-17 for wallet 0x1A36...C3B5, and the
 * whole plan was executed against a Base fork at block 50,099,851 through the
 * real distributor: the three token balances moved by exactly the
 * `deliveredAmountRaw` figures below, and `claimed(wallet, token)` afterwards
 * equalled exactly the `cumulativeAmountRaw` sent. That run is why
 * `cumulativeAmountRaw` (not the delivered amount) is what the calldata carries.
 */

import { describe, it, expect } from "vitest";
import { getAddress, type Address } from "viem";

import { planMerklClaim } from "@tools/merkl/claim.js";
import {
  assertMerklClaimCalldata,
  buildMerklClaimCalldata,
  isMerklDistributor,
  merklDistributorAddress,
} from "@tools/merkl/distributor.js";
import type { MerklAttributedChainRewards, MerklAttributedReward } from "@tools/merkl/rewards.js";

const WALLET = getAddress("0x1A364E522A5Af6187Dc50b6DE9e41458F413C3B5");
const OTHER = getAddress("0x000000000000000000000000000000000000dEaD");
const ROOT = "0x9ba8e44a9319d7576b5554e847df60f626ee9a911893b7dc484838c222dc68f8";
const PROOF = ["0xa0f1af2b65a362dc9fb862ed2b0e90446973728ec26f9df03d927fbe5afa6755"];

const WELL = "0xa88594d404727625a9437c3f886c7643872296ae";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function reward(over: Partial<MerklAttributedReward> & { token: MerklAttributedReward["token"] }): MerklAttributedReward {
  return {
    chainId: 8453,
    amountRaw: "27432641656621057711362",
    claimedRaw: "26977794427478008954964",
    pendingRaw: "41533541539924343923",
    claimableRaw: "454847229143048756398",
    root: ROOT,
    proofs: PROOF,
    breakdowns: [],
    sources: [],
    hasMorphoSource: true,
    ...over,
  };
}

const wellRow = reward({
  token: { address: WELL, symbol: "WELL", decimals: 18, priceUsd: 0.0027947966913422434 },
});
const usdcRow = reward({
  token: { address: USDC, symbol: "USDC", decimals: 6, priceUsd: 1 },
  amountRaw: "100807396",
  claimedRaw: "99898266",
  claimableRaw: "909130",
  hasMorphoSource: false,
});

function chain(rewards: readonly MerklAttributedReward[]): MerklAttributedChainRewards {
  return {
    chainId: 8453,
    chainName: "Base",
    rewards,
    attribution: {
      resolvedOpportunities: 1,
      unresolvedOpportunities: 0,
      unattributableRewards: 0,
      complete: true,
      lookupCapReached: false,
    },
  };
}

describe("the pinned distributor", () => {
  it("answers for every chain the address was actually measured on", () => {
    // Probed 2026-08-17 through Vex's own RPC table: code present and a live
    // getMerkleRoot() on all nine of Vex's Morpho chains.
    for (const chainId of [1, 10, 130, 137, 143, 999, 4663, 8453, 42161]) {
      expect(merklDistributorAddress(chainId), String(chainId)).toBeDefined();
    }
  });

  it("REFUSES a chain it has not verified rather than assuming the canonical address", () => {
    // Merkl deploys widely; "probably the same everywhere" is how a transaction
    // gets signed to an address nobody checked.
    expect(merklDistributorAddress(480)).toBeUndefined();
    expect(merklDistributorAddress(747474)).toBeUndefined();
  });

  it("recognises its own address whatever the caller's casing", () => {
    const address = merklDistributorAddress(8453);
    if (address === undefined) throw new Error("expected Base to be verified");
    expect(isMerklDistributor(address.toLowerCase())).toBe(true);
    expect(isMerklDistributor(OTHER)).toBe(false);
  });
});

describe("planning a claim", () => {
  it("carries the CUMULATIVE leaf and the delivered amount as separate numbers", () => {
    const plan = planMerklClaim(chain([wellRow]), { morphoOnly: false });

    expect(plan.leaves).toHaveLength(1);
    const leaf = plan.leaves[0];
    if (leaf === undefined) throw new Error("expected one leaf");
    // What the proof authorizes and the calldata sends.
    expect(leaf.cumulativeAmountRaw).toBe("27432641656621057711362");
    // What the wallet actually receives. The fork run moved exactly this.
    expect(leaf.deliveredAmountRaw).toBe("454847229143048756398");
    expect(leaf.tokenDecimals).toBe(18);
  });

  it("excludes a row with nothing left to claim, and says which", () => {
    const settled = reward({ token: wellRow.token, claimableRaw: "0" });
    const plan = planMerklClaim(chain([settled]), { morphoOnly: false });

    expect(plan.leaves).toHaveLength(0);
    expect(plan.excluded).toEqual([
      { tokenAddress: WELL, tokenSymbol: "WELL", claimableRaw: "0", reason: "nothing_claimable" },
    ]);
  });

  it("REFUSES a row whose proof Merkl did not publish, instead of claiming without one", () => {
    // The read lane still reports this reward; the claim lane will not sign for
    // it. "Vex could not read the authorization for your 454 WELL" and "you have
    // nothing to claim" are different answers.
    const unprovable = reward({ token: wellRow.token, proofs: null });
    const plan = planMerklClaim(chain([unprovable]), { morphoOnly: false });

    expect(plan.leaves).toHaveLength(0);
    expect(plan.hasUnprovableRewards).toBe(true);
    expect(plan.excluded[0]?.reason).toBe("no_proof_published");
  });

  it("narrows ROWS by Morpho attribution, and the excluded row keeps its claimable figure", () => {
    // A claim cannot deliver part of a leaf, so morphoOnly selects whole token
    // rows. The USDC the wallet could also claim is named, not hidden.
    const plan = planMerklClaim(chain([wellRow, usdcRow]), { morphoOnly: true });

    expect(plan.leaves.map((leaf) => leaf.tokenAddress)).toEqual([WELL]);
    expect(plan.excluded).toEqual([
      { tokenAddress: USDC, tokenSymbol: "USDC", claimableRaw: "909130", reason: "not_morpho" },
    ]);
  });

  it("does not blame Morpho narrowing on an unreadable proof", () => {
    // Order matters: a wallet asking about Morpho must not be told an unrelated
    // token's proof was broken.
    const unprovableUsdc = reward({ token: usdcRow.token, proofs: null, hasMorphoSource: false });
    const plan = planMerklClaim(chain([unprovableUsdc]), { morphoOnly: true });

    expect(plan.excluded[0]?.reason).toBe("not_morpho");
    expect(plan.hasUnprovableRewards).toBe(false);
  });
});

describe("the pre-signature assertion", () => {
  const distributor = merklDistributorAddress(8453) as Address;
  const leaves = planMerklClaim(chain([wellRow, usdcRow]), { morphoOnly: false }).leaves;
  const call = buildMerklClaimCalldata(distributor, WALLET, leaves);

  it("passes the calldata this engine builds, decoded back through the ABI", () => {
    expect(assertMerklClaimCalldata(call, WALLET, leaves)).toEqual({ ok: true, failure: null, detail: null });
  });

  it("refuses a target that is not the pinned distributor", () => {
    const result = assertMerklClaimCalldata({ ...call, to: OTHER }, WALLET, leaves);
    expect(result.failure).toBe("target_not_distributor");
  });

  it("refuses a claim carrying value, which a claim never spends", () => {
    const result = assertMerklClaimCalldata({ ...call, value: 1n }, WALLET, leaves);
    expect(result.failure).toBe("value_not_zero");
  });

  it("refuses calldata that is not a claim call at all", () => {
    const result = assertMerklClaimCalldata({ ...call, data: "0xdeadbeef" }, WALLET, leaves);
    expect(result.failure).toBe("not_a_claim_call");
  });

  it("REFUSES a claim built for another wallet, which would pay them and bill us for gas", () => {
    // The distributor accepts a proof naming anyone and pays the wallet in the
    // leaf, not the sender. This is the assertion that makes that harmless.
    const foreign = buildMerklClaimCalldata(distributor, OTHER, leaves);
    const result = assertMerklClaimCalldata(foreign, WALLET, leaves);
    expect(result.failure).toBe("user_not_wallet");
    expect(result.detail).toContain(WALLET.toLowerCase());
  });

  it("refuses when the decoded leaves do not match the rewards the plan was built from", () => {
    const shorter = leaves.slice(0, 1);
    expect(assertMerklClaimCalldata(call, WALLET, shorter).failure).toBe("leaf_count_mismatch");
  });

  it("catches a token/amount pairing that drifted from the plan", () => {
    // A reordered amounts array against an unreordered tokens array is a
    // perfectly valid transaction that claims the wrong number for the wrong
    // asset. Decoding the bytes back is what catches it.
    const swapped = [leaves[1], leaves[0]].filter((leaf) => leaf !== undefined);
    const result = assertMerklClaimCalldata(call, WALLET, swapped);
    expect(result.failure).toBe("token_mismatch");
  });

  it("catches a proof that is not the one Merkl published", () => {
    const tampered = leaves.map((leaf, index) =>
      index === 0 ? { ...leaf, proof: [`0x${"9".repeat(64)}`] } : leaf,
    );
    expect(assertMerklClaimCalldata(call, WALLET, tampered).failure).toBe("proof_mismatch");
  });
});
