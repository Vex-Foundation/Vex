/**
 * Projection of Merkl reward rows into agent-facing shape.
 *
 * THE ARITHMETIC IS THE POINT OF THIS MODULE. Merkl reports three raw numbers
 * per reward token and only their DIFFERENCE is claimable: `amount` is lifetime
 * accrual inside the current Merkle root, `claimed` is what has already been
 * taken on-chain, and `pending` is accrual that is not in a root yet and so
 * cannot be claimed at all. A live Base row on 2026-08-14 read
 * `amount 27159256967843778403797` against `claimed 26977794427478008954964`:
 * reporting `amount` as the claim would have overstated it by roughly 150x. All
 * three are surfaced, each labelled, and `claimable` is computed in BigInt.
 *
 * USD IS AN ESTIMATE FROM A THIN FEED. Incentive tokens are exactly where a
 * price oracle is least reliable, so `usd` is derived from Merkl's own
 * `token.price` and carried as an estimate, `null` when Merkl priced nothing.
 * It is never used to decide anything.
 */

import { formatRawAmount, type ProjectedAmount } from "./_shared.js";
import type { MerklAttributedChainRewards, MerklAttributedReward, MerklRewardSource } from "@tools/merkl/rewards.js";

/** The sentence every reward figure in this lane is qualified by. */
export const MORPHO_REWARDS_CLAIM_NOTE =
  "`claimable` is what a claim would deliver right now (Merkl's lifetime `accrued` minus what has already been "
  + "claimed). `pending` is accrual Merkl has computed but not yet published into a claimable root, so it is NOT "
  + "part of `claimable` and may still change. Claiming is an on-chain transaction that costs gas; Vex CAN perform "
  + "it with `morpho__rewards_claim`, which sweeps a whole chain's claimable rows in one transaction.";

export const MORPHO_REWARDS_USD_NOTE =
  "USD here is Merkl's own price for the reward token, not a measured trade price. Incentive tokens are frequently "
  + "thin, so treat the figure as an estimate and check what the token is actually worth before valuing a position "
  + "on it. A reward token's price moves independently of the asset that was supplied to earn it.";

export interface ProjectedRewardSource {
  protocolId: string | null;
  protocolName: string | null;
  isMorpho: boolean;
  opportunityName: string | null;
  campaignCount: number;
  claimable: ProjectedAmount;
}

export interface ProjectedReward {
  chain: string;
  token: { address: string; symbol: string | null; decimals: number; priceUsd: number | null };
  claimable: ProjectedAmount;
  pending: ProjectedAmount;
  lifetimeAccrued: ProjectedAmount;
  alreadyClaimed: ProjectedAmount;
  hasMorphoSource: boolean;
  sources: readonly ProjectedRewardSource[];
}

function amount(
  raw: string,
  decimals: number,
  symbol: string | null,
  priceUsd: number | null,
): ProjectedAmount {
  const human = formatRawAmount(raw, decimals);
  return {
    raw,
    decimals,
    symbol,
    human,
    // Priced off the HUMAN value, never off the raw integer, and only when Merkl
    // supplied a price. `Number(human)` is safe here in a way it is not for the
    // raw amount: it is a display estimate, and the exact figure is `raw`.
    usd: priceUsd === null ? null : Number(human) * priceUsd,
  };
}

function projectSource(
  source: MerklRewardSource,
  decimals: number,
  symbol: string | null,
  priceUsd: number | null,
): ProjectedRewardSource {
  return {
    protocolId: source.protocolId,
    protocolName: source.protocolName,
    isMorpho: source.isMorpho,
    opportunityName: source.opportunityName,
    campaignCount: source.campaignCount,
    claimable: amount(source.claimableRaw, decimals, symbol, priceUsd),
  };
}

export function projectReward(reward: MerklAttributedReward, chainSlug: string): ProjectedReward {
  const { decimals, symbol, priceUsd } = reward.token;
  return {
    chain: chainSlug,
    token: { address: reward.token.address, symbol, decimals, priceUsd },
    claimable: amount(reward.claimableRaw, decimals, symbol, priceUsd),
    pending: amount(reward.pendingRaw, decimals, symbol, priceUsd),
    lifetimeAccrued: amount(reward.amountRaw, decimals, symbol, priceUsd),
    alreadyClaimed: amount(reward.claimedRaw, decimals, symbol, priceUsd),
    hasMorphoSource: reward.hasMorphoSource,
    sources: reward.sources.map((source) => projectSource(source, decimals, symbol, priceUsd)),
  };
}

export interface ProjectedRewardChain {
  chain: string;
  chainId: number;
  rewards: readonly ProjectedReward[];
  attribution: MerklAttributedChainRewards["attribution"];
  /** Set when this chain could not be read at all. Distinct from "no rewards". */
  error: string | null;
}

/**
 * Sum the claimable USD across every projected reward, and say how much of the
 * total could not be valued.
 *
 * The unpriced count is reported rather than absorbed: a total that silently
 * omitted three unpriced tokens reads as the whole answer.
 */
export function summariseClaimableUsd(
  chains: readonly ProjectedRewardChain[],
): { claimableUsd: number; unpricedTokens: number; morphoAttributedTokens: number } {
  let claimableUsd = 0;
  let unpricedTokens = 0;
  let morphoAttributedTokens = 0;
  for (const chain of chains) {
    for (const reward of chain.rewards) {
      if (reward.claimable.raw === "0") continue;
      if (reward.claimable.usd === null) unpricedTokens += 1;
      else claimableUsd += reward.claimable.usd;
      if (reward.hasMorphoSource) morphoAttributedTokens += 1;
    }
  }
  return { claimableUsd, unpricedTokens, morphoAttributedTokens };
}
