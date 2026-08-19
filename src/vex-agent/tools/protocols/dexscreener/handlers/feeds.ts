/**
 * The promotional / profile FEED handlers.
 *
 * `profiles`, `profiles.recent`, `boosts`, `boosts.top`, `communityTakeovers`,
 * `ads` and the synthetic `attention` merge. These are the HUNTING surface: the
 * six provider feeds are the only endpoints in this API that surface tokens the
 * agent has not already named, so they are what turns "confirm this token" into
 * "find me a token".
 *
 * Before this card all seven declared ZERO parameters between them (one, `limit`,
 * on `attention`, with a silent default of 20). The consequence was a loop: no
 * params → the agent compensates with call volume → every call returns everything
 * → everything blobs → the agent spends more calls reading blobs back. The owner's
 * worked example was not slow but IMPOSSIBLE: "fresh memecoins on the robinhood
 * chain" could not be expressed, because `profiles.recent` had no chain filter and
 * returned 30 rows across all chains at 40,089 B — 2.45x the 16 KiB cap.
 *
 * All seven now share ONE vocabulary through `../feed-list/`: `limit` (no
 * default), `offset`, `fields`, `chainIds`, `sortBy`, `sortDir`, plus the per-feed
 * extras the provider can actually honour. Every output carries the provenance
 * envelope, including `droppedByFilter`, so a filtered-to-empty feed is
 * self-diagnosing rather than reading as "nothing exists".
 *
 * FAILURES ARE NOT SWALLOWED. The recent-updates handler used to catch every
 * error without binding it and return `ok({available:false, reason:
 * "…undocumented endpoint that may have changed"})` — a success row for a failed
 * call, asserting a cause nobody had established (a 429, a timeout and a DNS
 * failure all produced that same sentence) and telling the agent to abandon the
 * tool permanently instead of waiting. Those catches are gone: the error reaches
 * `protocols/runtime.ts`, which is already the one place that classifies it,
 * scrubs it, preserves `retryable`, and returns `success:false`.
 */

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import type { ProtocolHandler } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import {
  buildFeedList,
  mergeAttentionRows,
  parseFeedListQuery,
  toAdFeedRow,
  toAttentionFeedRow,
  toBoostFeedRow,
  toProfileFeedRow,
  toTakeoverFeedRow,
  type FeedListQueryDefaults,
} from "../feed-list/index.js";
import { combinedSourceObservation, sourceObservation } from "./source-observation.js";

/** Both profile feeds: they carry `updatedAt` + `cto` and no boost units. */
const PROFILE_FEED: FeedListQueryDefaults = {
  eventAgeParam: "updatedWithinSeconds",
  supportsCtoFilter: true,
  supportsBoostFilter: false,
  sortKeys: ["relevance", "eventAgeSeconds"],
  sortBy: "relevance",
  limit: 20,
};

/**
 * Both boost feeds. NO freshness filter or sort: these two endpoints carry no
 * timestamp of any kind, so an age filter could only ever drop every row.
 */
const BOOST_FEED: FeedListQueryDefaults = {
  eventAgeParam: null,
  supportsCtoFilter: false,
  supportsBoostFilter: true,
  sortKeys: ["relevance", "boostCount", "boostCountTotal"],
  sortBy: "relevance",
  limit: null,
};

const TOP_BOOST_FEED: FeedListQueryDefaults = {
  ...BOOST_FEED,
  sortBy: "boostCountTotal",
};

const TAKEOVER_FEED: FeedListQueryDefaults = {
  eventAgeParam: "claimedWithinSeconds",
  supportsCtoFilter: false,
  supportsBoostFilter: false,
  sortKeys: ["relevance", "eventAgeSeconds"],
  sortBy: "relevance",
  limit: null,
};

const AD_FEED: FeedListQueryDefaults = {
  eventAgeParam: "placedWithinSeconds",
  supportsCtoFilter: false,
  supportsBoostFilter: false,
  sortKeys: ["relevance", "eventAgeSeconds", "adImpressionCount"],
  sortBy: "relevance",
  limit: null,
};

/**
 * The merge. Boost units come from the boost half, so the boost filter applies;
 * the profile half's `updatedAt` does not survive the merge (the provider's
 * `DexTrendingItem` never carried it), so there is no freshness filter here.
 */
const ATTENTION_FEED: FeedListQueryDefaults = {
  eventAgeParam: null,
  supportsCtoFilter: false,
  supportsBoostFilter: true,
  sortKeys: ["relevance", "boostCount", "boostCountTotal"],
  sortBy: "boostCountTotal",
  limit: null,
};

export const DEXSCREENER_FEED_HANDLERS: Record<string, ProtocolHandler> = {
  "dexscreener.profiles": async (p) => {
    const parsed = parseFeedListQuery(p, PROFILE_FEED);
    if (!parsed.ok) return fail(`dexscreener.profiles: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const profiles = await client.getProfiles();
    const asOfMs = Date.now();
    return ok({
      sourceObservation: sourceObservation(client, profiles, asOfMs),
      ...buildFeedList({
        endpoint: "/token-profiles/latest/v1",
        providerRows: profiles.map(toProfileFeedRow),
        query: parsed.query,
        asOfMs,
      }),
    });
  },

  "dexscreener.profiles.recent": async (p) => {
    const parsed = parseFeedListQuery(p, PROFILE_FEED);
    if (!parsed.ok) return fail(`dexscreener.profiles.recent: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const profiles = await client.getProfilesRecentUpdates();
    const asOfMs = Date.now();
    return ok({
      sourceObservation: sourceObservation(client, profiles, asOfMs),
      ...buildFeedList({
        endpoint: "/token-profiles/recent-updates/v1",
        providerRows: profiles.map(toProfileFeedRow),
        query: parsed.query,
        asOfMs,
      }),
    });
  },

  // `boostCount` is null on every row of the `top` feed and populated on `latest`;
  // `skippedRows` reports rows the parser could not read, so a thinned feed is
  // visible rather than silent.
  "dexscreener.boosts": async (p) => {
    const parsed = parseFeedListQuery(p, BOOST_FEED);
    if (!parsed.ok) return fail(`dexscreener.boosts: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const feed = await client.getBoosts();
    const asOfMs = Date.now();
    return ok({
      skippedRows: feed.skipped,
      sourceObservation: sourceObservation(client, feed, asOfMs),
      ...buildFeedList({
        endpoint: "/token-boosts/latest/v1",
        providerRows: feed.boosts.map(toBoostFeedRow),
        query: parsed.query,
        asOfMs,
      }),
    });
  },

  "dexscreener.boosts.top": async (p) => {
    const parsed = parseFeedListQuery(p, TOP_BOOST_FEED);
    if (!parsed.ok) return fail(`dexscreener.boosts.top: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const feed = await client.getTopBoosts();
    const asOfMs = Date.now();
    return ok({
      skippedRows: feed.skipped,
      sourceObservation: sourceObservation(client, feed, asOfMs),
      ...buildFeedList({
        endpoint: "/token-boosts/top/v1",
        providerRows: feed.boosts.map(toBoostFeedRow),
        query: parsed.query,
        asOfMs,
      }),
    });
  },

  "dexscreener.communityTakeovers": async (p) => {
    const parsed = parseFeedListQuery(p, TAKEOVER_FEED);
    if (!parsed.ok) return fail(`dexscreener.communityTakeovers: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const takeovers = await client.getCommunityTakeovers();
    const asOfMs = Date.now();
    return ok({
      sourceObservation: sourceObservation(client, takeovers, asOfMs),
      ...buildFeedList({
        endpoint: "/community-takeovers/latest/v1",
        providerRows: takeovers.map(toTakeoverFeedRow),
        query: parsed.query,
        asOfMs,
      }),
    });
  },

  "dexscreener.attention": async (p) => {
    const parsed = parseFeedListQuery(p, ATTENTION_FEED);
    if (!parsed.ok) return fail(`dexscreener.attention: ${parsed.reason}`);

    const client = getDexScreenerClient();
    // Two SLOW-lane calls (60/min) for one tool. Fetched in parallel, as before.
    const [profiles, boostFeed] = await Promise.all([
      client.getProfiles(),
      client.getBoosts(),
    ]);
    const asOfMs = Date.now();
    const merged = mergeAttentionRows(profiles, boostFeed.boosts);

    return ok({
      skippedBoostRows: boostFeed.skipped,
      sourceObservation: combinedSourceObservation(client, [profiles, boostFeed], asOfMs),
      ...buildFeedList({
        // Synthetic: two endpoints, one window. Named as the merge rather than as
        // either half, so `providerReturned` is not read as one endpoint's cap.
        endpoint: "/token-profiles/latest/v1 + /token-boosts/latest/v1 (merged by Vex)",
        providerRows: merged.map(toAttentionFeedRow),
        query: parsed.query,
        asOfMs,
      }),
    });
  },

  "dexscreener.ads": async (p) => {
    const parsed = parseFeedListQuery(p, AD_FEED);
    if (!parsed.ok) return fail(`dexscreener.ads: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const ads = await client.getAds();
    const asOfMs = Date.now();
    return ok({
      sourceObservation: sourceObservation(client, ads, asOfMs),
      ...buildFeedList({
        endpoint: "/ads/latest/v1",
        providerRows: ads.map(toAdFeedRow),
        query: parsed.query,
        asOfMs,
      }),
    });
  },
};
