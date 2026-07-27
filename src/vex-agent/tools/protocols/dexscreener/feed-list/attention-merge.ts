/**
 * The `dexscreener.attention` merge — two feeds, one deduplicated window.
 *
 * `attention` is the only synthetic tool in this namespace: it joins
 * `/token-profiles/latest/v1` and `/token-boosts/latest/v1` on
 * `chainId:tokenAddress` to answer "which specific tokens are buying visibility".
 * It costs two SLOW-lane calls (60/min) and can return up to ~60 rows where every
 * other feed returns 30 — measured 54 today.
 *
 * ONE FABRICATED ZERO REMOVED
 *
 * A token present in the profiles window and absent from the boosts window used to
 * be given `boostAmount: 0, boostTotalAmount: 0`. That is a measurement we never
 * took: the boosts feed is a 30-row window with a hard cap, so absence from it does
 * not prove the token has no boost — it proves the token was not in the 30 rows we
 * were sent. Both are now `null`, which is "unknown".
 *
 * Ordering is unaffected. `null` and a measured `0` both sort below every positive
 * value under the nulls-last comparator, so a boosted token still outranks an
 * unboosted one; what changes is that the agent can no longer read a fabricated
 * zero as "verified to have no boost". `hasProfile` remains the field that says
 * which half of the merge a row came from.
 */

import type { DexBoost, DexTokenProfile, DexTrendingItem } from "@tools/dexscreener/types.js";

/**
 * Join the two windows, boosts first so a token in both keeps its boost units.
 *
 * Row ORDER out of this function is the boost feed's order followed by the
 * profile-only rows, which is `providerOrder: "unspecified"` — neither endpoint
 * discloses an order, and the merge does not invent one. Sorting is the caller's
 * `sortBy`, defaulted to `boostCountTotal` because "who is spending" is the one
 * question this tool exists to answer.
 */
export function mergeAttentionRows(
  profiles: readonly DexTokenProfile[],
  boosts: readonly DexBoost[],
): DexTrendingItem[] {
  const merged = new Map<string, DexTrendingItem>();

  for (const boost of boosts) {
    merged.set(`${boost.chainId}:${boost.tokenAddress}`, {
      chainId: boost.chainId,
      tokenAddress: boost.tokenAddress,
      url: boost.url,
      icon: boost.icon,
      header: boost.header,
      description: boost.description,
      links: boost.links,
      boostAmount: boost.amount,
      boostTotalAmount: boost.totalAmount,
      hasProfile: false,
    });
  }

  for (const profile of profiles) {
    const key = `${profile.chainId}:${profile.tokenAddress}`;
    const existing = merged.get(key);
    if (existing !== undefined) {
      // The boost row wins on identity and units; the profile fills the display
      // gaps the boost feed left null.
      existing.hasProfile = true;
      existing.icon = existing.icon ?? profile.icon;
      existing.description = existing.description ?? profile.description;
      existing.links = existing.links ?? profile.links;
      continue;
    }
    merged.set(key, {
      chainId: profile.chainId,
      tokenAddress: profile.tokenAddress,
      url: profile.url,
      icon: profile.icon,
      header: profile.header,
      description: profile.description,
      links: profile.links,
      // `null`, not `0` — see the module docstring. Absence from a capped window
      // is not a measurement of zero.
      boostAmount: null,
      boostTotalAmount: null,
      hasProfile: true,
    });
  }

  return Array.from(merged.values());
}
