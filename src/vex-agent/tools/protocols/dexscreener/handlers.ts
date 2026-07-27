/**
 * DexScreener protocol handlers — direct TS client calls.
 *
 * All handlers import from @tools/dexscreener/client.
 * All read-only — no wallet, no signing, no mutations.
 *
 * Market-data handlers (search/pairs/tokens/tokenPairs) return the unified
 * concise pair projection (see `projectors.ts`) — never the raw fat DexPair.
 *
 * FAILURES ARE NOT SWALLOWED. The metas / recent-updates handlers used to catch
 * every error without binding it and return `ok({available:false, reason:
 * "…undocumented endpoint that may have changed"})` — a success row for a
 * failed call, asserting a cause nobody had established (a 429, a timeout and a
 * DNS failure all produced that same sentence) and telling the agent to abandon
 * the tool permanently instead of waiting. Those catches are gone: the error now
 * reaches `protocols/runtime.ts`, which is already the one place that classifies
 * it (`summarizeProtocolError` → `rate_limit` / `timeout` / `network` /
 * `response_schema` / `provider_error`), scrubs it, preserves `retryable`, and
 * returns `success:false`. Re-deriving any of that here would be a second,
 * worse copy of a classifier we already own.
 */

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import type { DexPair, DexTrendingItem } from "@tools/dexscreener/types.js";
import type { ProtocolHandler } from "../types.js";
import { str, num, ok, fail } from "../handler-helpers.js";
import { projectPairs } from "./projectors.js";

// ── Search tuning ────────────────────────────────────────────────

/** Default result cap for `dexscreener.search` when the caller omits `limit`. */
const SEARCH_DEFAULT_LIMIT = 20;
/** Hard ceiling for `dexscreener.search` (DexScreener search returns ≤30 pairs). */
const SEARCH_MAX_LIMIT = 30;

function clampSearchLimit(requested: number | undefined): number {
  if (requested !== undefined && requested > 0) {
    return Math.min(Math.floor(requested), SEARCH_MAX_LIMIT);
  }
  return SEARCH_DEFAULT_LIMIT;
}

// ── Handler map ──────────────────────────────────────────────────

export const DEXSCREENER_HANDLERS: Record<string, ProtocolHandler> = {
  // ── Core data ─────────────────────────────────────────────────

  "dexscreener.search": async (p) => {
    const query = str(p, "query");
    if (!query) return fail("Missing required: query");
    // Optional client-side filters — the search API has no server-side chain
    // or liquidity parameter, so we filter the returned pairs here.
    const chainId = str(p, "chainId");
    const minLiquidityUsd = num(p, "minLiquidityUsd");
    const requestedLimit = num(p, "limit");

    const client = getDexScreenerClient();
    const result = await client.search(query);

    let pairs = result.pairs;
    if (chainId) {
      const want = chainId.toLowerCase();
      pairs = pairs.filter((pr) => pr.chainId.toLowerCase() === want);
    }
    if (minLiquidityUsd !== undefined) {
      pairs = pairs.filter((pr) => (pr.liquidity?.usd ?? -Infinity) >= minLiquidityUsd);
    }

    // Deepest liquidity first, then cap for context economy.
    const sorted = [...pairs].sort(
      (a: DexPair, b: DexPair) => (b.liquidity?.usd ?? -Infinity) - (a.liquidity?.usd ?? -Infinity),
    );
    const limit = clampSearchLimit(requestedLimit);
    const projected = projectPairs(sorted).slice(0, limit);

    return ok({
      query,
      chainId: chainId || null,
      matched: sorted.length,
      pairCount: projected.length,
      pairs: projected,
    });
  },

  "dexscreener.pairs": async (p) => {
    const chainId = str(p, "chainId"), pairAddress = str(p, "pairAddress");
    if (!chainId || !pairAddress) return fail("Missing required: chainId, pairAddress");
    const client = getDexScreenerClient();
    const result = await client.getPairs(chainId, pairAddress);
    return ok({ chainId, pairAddress, pairs: projectPairs(result.pairs) });
  },

  "dexscreener.tokens": async (p) => {
    const chainId = str(p, "chainId"), tokenAddresses = str(p, "tokenAddresses");
    if (!chainId || !tokenAddresses) return fail("Missing required: chainId, tokenAddresses");
    const client = getDexScreenerClient();
    const result = await client.getTokens(chainId, tokenAddresses);
    return ok({ chainId, pairCount: result.length, pairs: projectPairs(result) });
  },

  "dexscreener.tokenPairs": async (p) => {
    const chainId = str(p, "chainId"), tokenAddress = str(p, "tokenAddress");
    if (!chainId || !tokenAddress) return fail("Missing required: chainId, tokenAddress");
    const limit = num(p, "limit");
    const client = getDexScreenerClient();
    const result = await client.getTokenPairs(chainId, tokenAddress);

    // Surface the deepest pools first: a token can have many pairs and the model
    // almost always wants the best-liquidity venue. `liquidity.usd` is
    // `number | null` — null-coalesce to -Infinity so missing-liquidity pairs
    // sink to the bottom. Sort a copy to avoid mutating the client response.
    const sorted = [...result].sort(
      (a: DexPair, b: DexPair) => (b.liquidity?.usd ?? -Infinity) - (a.liquidity?.usd ?? -Infinity),
    );

    // Apply `limit` ONLY when the caller provides it — no hardcoded default, so
    // an unqualified call still returns the full (sorted) pair set.
    const limited = limit && limit > 0 ? sorted.slice(0, limit) : sorted;

    return ok({ chainId, tokenAddress, pairCount: limited.length, pairs: projectPairs(limited) });
  },

  // ── Profiles & attention signals ──────────────────────────────

  "dexscreener.profiles": async () => {
    const client = getDexScreenerClient();
    const profiles = await client.getProfiles();
    return ok({ count: profiles.length, profiles });
  },

  "dexscreener.profiles.recent": async () => {
    const client = getDexScreenerClient();
    const profiles = await client.getProfilesRecentUpdates();
    return ok({ count: profiles.length, profiles });
  },

  // `amount` is null on every row of the `top` feed and populated on `latest`;
  // `skipped` reports rows the parser could not read, so a thinned feed is
  // visible rather than silent.
  "dexscreener.boosts": async () => {
    const client = getDexScreenerClient();
    const feed = await client.getBoosts();
    return ok({ count: feed.boosts.length, skipped: feed.skipped, boosts: feed.boosts });
  },

  "dexscreener.boosts.top": async () => {
    const client = getDexScreenerClient();
    const feed = await client.getTopBoosts();
    return ok({ count: feed.boosts.length, skipped: feed.skipped, boosts: feed.boosts });
  },

  "dexscreener.communityTakeovers": async () => {
    const client = getDexScreenerClient();
    const takeovers = await client.getCommunityTakeovers();
    return ok({ count: takeovers.length, takeovers });
  },

  "dexscreener.attention": async (p) => {
    // Synthetic attention signal: merge of token-profiles + boosts, ranked by
    // paid boost then profile presence. This is NOT the official trending feed
    // (that is `dexscreener.trending`) — it surfaces who is spending on
    // visibility. Default to 20 when the caller omits `limit`.
    const limit = num(p, "limit") ?? 20;
    const client = getDexScreenerClient();

    // Fetch profiles and boosts in parallel
    const [profiles, boostFeed] = await Promise.all([
      client.getProfiles(),
      client.getBoosts(),
    ]);

    // Merge by chainId:tokenAddress
    const map = new Map<string, DexTrendingItem>();

    for (const boost of boostFeed.boosts) {
      const key = `${boost.chainId}:${boost.tokenAddress}`;
      map.set(key, {
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
      const existing = map.get(key);
      if (existing) {
        existing.hasProfile = true;
        existing.icon = existing.icon ?? profile.icon;
        existing.description = existing.description ?? profile.description;
        existing.links = existing.links ?? profile.links;
      } else {
        map.set(key, {
          chainId: profile.chainId,
          tokenAddress: profile.tokenAddress,
          url: profile.url,
          icon: profile.icon,
          header: profile.header,
          description: profile.description,
          links: profile.links,
          boostAmount: 0,
          boostTotalAmount: 0,
          hasProfile: true,
        });
      }
    }

    // Sort: highest boost first, then profile presence. A `null` boost total
    // means the feed did not report one — it ranks below every measured value
    // (including a measured 0) instead of being coerced into a number, so an
    // unreported row can never outrank a real one. Compared with explicit
    // branches, never by subtraction: two unreported rows would subtract to
    // `NaN` and leave the comparator inconsistent.
    const compareBoostDesc = (a: number | null, b: number | null): number => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return b > a ? 1 : -1;
    };
    let items = Array.from(map.values()).sort((a, b) => {
      const byBoost = compareBoostDesc(a.boostTotalAmount, b.boostTotalAmount);
      if (byBoost !== 0) return byBoost;
      if (a.hasProfile !== b.hasProfile) return a.hasProfile ? -1 : 1;
      return 0;
    });

    if (limit && limit > 0) {
      items = items.slice(0, limit);
    }

    return ok({ count: items.length, skippedBoosts: boostFeed.skipped, items });
  },

  // ── Metas / narratives (live, undocumented) ───────────────────

  "dexscreener.trending": async (p) => {
    // Official trending NARRATIVES/themes feed (live, undocumented endpoint).
    // Returns categories (ai, dog, "knockoff-legends"), NOT individual tokens.
    const limit = num(p, "limit");
    const client = getDexScreenerClient();
    const metas = await client.getMetasTrending();
    const limited = limit && limit > 0 ? metas.slice(0, limit) : metas;
    return ok({ count: limited.length, metas: limited });
  },

  "dexscreener.meta": async (p) => {
    const slug = str(p, "slug");
    if (!slug) return fail("Missing required: slug");
    // `slug` is a NARRATIVE slug from dexscreener.trending, not a chain slug.
    const client = getDexScreenerClient();
    const detail = await client.getMeta(slug);
    // `null` is the tolerant validator's verdict on a body it could not read at
    // all. That IS an established cause — the provider answered and the payload
    // did not match the narrative shape — so it is reported as exactly that,
    // and as a failure. No claim is made about WHY the shape changed.
    if (!detail) {
      return fail(
        `dexscreener.meta could not read the narrative feed for "${slug}": the endpoint responded but the payload did not match the expected shape. Retrying will not change it. Check the slug against dexscreener.trending.`,
      );
    }
    return ok({
      slug: detail.slug,
      name: detail.name,
      description: detail.description,
      marketCap: detail.marketCap,
      liquidity: detail.liquidity,
      volume: detail.volume,
      tokenCount: detail.tokenCount,
      marketCapChange: detail.marketCapChange,
      pairCount: detail.pairs.length,
      pairs: projectPairs(detail.pairs),
    });
  },

  // ── Orders & ads ──────────────────────────────────────────────

  "dexscreener.orders": async (p) => {
    const chainId = str(p, "chainId"), tokenAddress = str(p, "tokenAddress");
    if (!chainId || !tokenAddress) return fail("Missing required: chainId, tokenAddress");
    const client = getDexScreenerClient();
    // The endpoint answers with BOTH the paid-order history and the
    // boost-payment ledger for the same token. Both are legitimacy signals, so
    // both are surfaced; the ledger used to be discarded entirely.
    const result = await client.getOrders(chainId, tokenAddress);
    return ok({
      chainId,
      tokenAddress,
      orderCount: result.orders.length,
      orders: result.orders,
      boostPaymentCount: result.boostPayments.length,
      boostPayments: result.boostPayments,
      skippedOrders: result.skippedOrders,
      skippedBoostPayments: result.skippedBoostPayments,
    });
  },

  "dexscreener.ads": async () => {
    const client = getDexScreenerClient();
    const ads = await client.getAds();
    return ok({ count: ads.length, ads });
  },
};
