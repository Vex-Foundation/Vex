/**
 * Turning a wallet's attributed rewards into the leaves a claim would send, and
 * saying out loud what was left behind.
 *
 * ── A CLAIM IS PER TOKEN ROW, SO `morphoOnly` NARROWS ROWS, NOT SLICES ──────
 *
 * `./rewards.ts` establishes the shape this module obeys: Merkl publishes one
 * leaf per wallet per reward token, and the campaign `breakdowns` beneath it
 * explain how that single leaf accrued. There is no calldata that claims part of
 * a leaf. So `morphoOnly` can decide WHICH TOKEN ROWS to include - a row with at
 * least one Morpho-attributed source - and it cannot make a claimed row deliver
 * only its Morpho share. A narrowed claim still pays out every campaign inside
 * the rows it selects, and the tool's wording has to say so rather than let the
 * flag imply a precision the contract does not have.
 *
 * ── WHAT IS REFUSED, AND WHY IT IS REFUSED BY NAME ─────────────────────────
 *
 * A row is excluded when it has nothing left to claim, when Merkl sent no
 * readable root or proof, or when `morphoOnly` bound. Each exclusion is COUNTED
 * AND LABELLED rather than silently dropped, because the difference between "you
 * have nothing to claim" and "Vex could not read the authorization for the
 * 413 WELL you have" is the whole answer. rules/90: a decoder that cannot prove
 * what happened declines and says which.
 */

import type { MerklAttributedChainRewards, MerklAttributedReward } from "./rewards.js";
import type { MerklClaimLeaf } from "./distributor.js";

/** Why a reward row the wallet holds is not in the claim. */
export type MerklClaimExclusionReason =
  | "nothing_claimable"
  | "no_proof_published"
  | "not_morpho";

export interface MerklClaimExclusion {
  readonly tokenAddress: string;
  readonly tokenSymbol: string | null;
  readonly claimableRaw: string;
  readonly reason: MerklClaimExclusionReason;
}

export interface MerklClaimPlan {
  readonly chainId: number;
  readonly leaves: readonly MerklClaimLeaf[];
  readonly excluded: readonly MerklClaimExclusion[];
  /** True when at least one row was held back because its proof was unreadable. */
  readonly hasUnprovableRewards: boolean;
}

function exclusion(
  reward: MerklAttributedReward,
  reason: MerklClaimExclusionReason,
): MerklClaimExclusion {
  return {
    tokenAddress: reward.token.address,
    tokenSymbol: reward.token.symbol,
    claimableRaw: reward.claimableRaw,
    reason,
  };
}

/**
 * Build the leaves for one chain's claim.
 *
 * The order of the checks is deliberate: `morphoOnly` is applied BEFORE the
 * proof check, so a wallet asking about Morpho is not told that some unrelated
 * token's proof was unreadable. Rows with nothing claimable are dropped first
 * of all, because a zero row is not a problem to report.
 */
export function planMerklClaim(
  chain: MerklAttributedChainRewards,
  options: { readonly morphoOnly: boolean },
): MerklClaimPlan {
  const leaves: MerklClaimLeaf[] = [];
  const excluded: MerklClaimExclusion[] = [];

  for (const reward of chain.rewards) {
    if (BigInt(reward.claimableRaw) <= 0n) {
      excluded.push(exclusion(reward, "nothing_claimable"));
      continue;
    }
    if (options.morphoOnly && !reward.hasMorphoSource) {
      excluded.push(exclusion(reward, "not_morpho"));
      continue;
    }
    if (reward.root === null || reward.proofs === null) {
      excluded.push(exclusion(reward, "no_proof_published"));
      continue;
    }
    leaves.push({
      tokenAddress: reward.token.address,
      tokenSymbol: reward.token.symbol,
      tokenDecimals: reward.token.decimals,
      // THE CUMULATIVE LEAF, which is what the proof authorizes and what the
      // contract compares against its own `claimed` ledger. Sending the
      // delivered amount here would fail the proof check on-chain.
      cumulativeAmountRaw: reward.amountRaw,
      deliveredAmountRaw: reward.claimableRaw,
      root: reward.root,
      proof: reward.proofs,
    });
  }

  return {
    chainId: chain.chainId,
    leaves,
    excluded,
    hasUnprovableRewards: excluded.some((row) => row.reason === "no_proof_published"),
  };
}
