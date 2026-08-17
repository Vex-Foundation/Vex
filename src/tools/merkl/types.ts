/**
 * Validated Merkl shapes. Every field here survived the tolerant reader in
 * `./validation.ts`, so a consumer may read it without re-checking.
 *
 * ONE SEMANTIC IS LOAD-BEARING AND EASY TO GET WRONG, so it is stated at the
 * type rather than left to a caller's memory. Merkl's `amount` is CUMULATIVE
 * LIFETIME accrual inside the current Merkle root, not a claimable balance.
 * `claimed` is the cumulative amount already taken on-chain. The number a user
 * can claim right now is `amount - claimed`. `pending` is accrual Merkl has
 * computed but not yet published into a root, so it is NOT claimable and must
 * never be added to the claimable figure.
 *
 * Live evidence (2026-08-14, wallet 0x1A36...C3B5 on Base): a WELL row read
 * `amount: "27159256967843778403797"`, `claimed: "26977794427478008954964"`,
 * `pending: "44606146182961419706"`. Reporting `amount` as claimable would have
 * overstated the claim by roughly 150x.
 */

/** The reward token, with the decimals needed to read the raw amounts beside it. */
export interface MerklRewardToken {
  address: string;
  symbol: string | null;
  decimals: number;
  /**
   * USD per WHOLE token, as Merkl priced it. Display-only and nullable: a thin
   * reward token's price is the least trustworthy number in the response, and a
   * strict read of it would drop a claimable reward over a cosmetic field.
   */
  priceUsd: number | null;
}

/** One campaign's contribution to a token's reward row. */
export interface MerklRewardBreakdown {
  /** Merkl's opaque campaign id. Identity, read strictly. */
  campaignId: string;
  /**
   * The opportunity this campaign belongs to. The ONLY key by which a reward can
   * be attributed to a protocol, so it is carried even when it cannot be
   * resolved.
   */
  opportunityId: string | null;
  /** Merkl's own free-text explanation of why this slice accrued. Display-only. */
  reason: string | null;
  amountRaw: string;
  claimedRaw: string;
  pendingRaw: string;
}

/** One reward token for one wallet on one chain, with its campaign breakdown. */
export interface MerklReward {
  chainId: number;
  token: MerklRewardToken;
  amountRaw: string;
  claimedRaw: string;
  pendingRaw: string;
  breakdowns: readonly MerklRewardBreakdown[];
}

/** Everything Merkl returned for one wallet on one chain. */
export interface MerklUserRewards {
  chainId: number;
  chainName: string | null;
  rewards: readonly MerklReward[];
}

/**
 * The attribution record for one opportunity: which protocol Merkl says the
 * campaign belongs to, and what it is called.
 */
export interface MerklOpportunity {
  id: string;
  name: string | null;
  action: string | null;
  protocolId: string | null;
  protocolName: string | null;
}
