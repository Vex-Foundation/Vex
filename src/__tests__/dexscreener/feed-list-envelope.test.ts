/**
 * The provenance envelope on the feed and narrative tools, over recorded live
 * windows.
 *
 * Four things here are the whole point:
 *
 * 1. **`returned + Σ droppedByFilter === providerReturned`** when the caller sets
 *    no window. Without that arithmetic `droppedByFilter` is decoration; with it,
 *    a filtered-to-empty feed is self-diagnosing instead of reading as "there is
 *    nothing on this chain".
 * 2. **Omitting `limit` returns every row the provider returned.** `attention`
 *    used to hide `limit = 20` against a 54-row merge and cut 34 rows with no flag
 *    and no count.
 * 3. **Issuer-authored text is delivered in full and NAMED**, per owner decision
 *    O9 — no bounds, no truncation marker, provenance labelled instead.
 * 4. **The two fields we were paying for and discarding** — `updatedAt` and `cto`
 *    — reach the agent on BOTH profile feeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import {
  adsLatest,
  boostsLatest,
  boostsTop,
  communityTakeovers,
  metaCat,
  metasTrending,
  profilesLatest,
  profilesRecent,
} from "./_feed-captures.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

interface FeedEnvelope {
  asOfMs: number;
  providerWindow: {
    endpoint: string;
    providerReturned: number;
    providerCap: number | null;
    providerCapped: boolean | null;
    providerOrder: string;
    note: string;
  };
  totalMatched: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  filtersApplied: Record<string, unknown>;
  droppedByFilter: Record<string, number>;
  externalContentWarning: string;
  externalContentFields: string[];
  rows: Array<Record<string, unknown>>;
}

async function call(
  toolId: string,
  params: Record<string, unknown> = {},
): Promise<FeedEnvelope & Record<string, unknown>> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  expect(result.success, result.output).toBe(true);
  return JSON.parse(result.output) as FeedEnvelope & Record<string, unknown>;
}

async function refuse(toolId: string, params: Record<string, unknown>): Promise<string> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  expect(result.success, `expected ${toolId} to refuse ${JSON.stringify(params)}`).toBe(false);
  return result.output;
}

function totalDropped(dropped: Record<string, number>): number {
  return Object.values(dropped).reduce((sum, count) => sum + count, 0);
}

/** Every feed tool, so an invariant is asserted on all of them rather than one. */
const FEED_TOOLS = [
  "dexscreener.profiles",
  "dexscreener.profiles.recent",
  "dexscreener.boosts",
  "dexscreener.boosts.top",
  "dexscreener.communityTakeovers",
  "dexscreener.attention",
  "dexscreener.ads",
] as const;

describe("DexScreener feed provenance envelope", () => {
  beforeEach(() => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getProfiles").mockResolvedValue(profilesLatest());
    vi.spyOn(client, "getProfilesRecentUpdates").mockResolvedValue(profilesRecent());
    vi.spyOn(client, "getBoosts").mockResolvedValue(boostsLatest());
    vi.spyOn(client, "getTopBoosts").mockResolvedValue(boostsTop());
    vi.spyOn(client, "getCommunityTakeovers").mockResolvedValue(communityTakeovers());
    vi.spyOn(client, "getAds").mockResolvedValue(adsLatest());
    vi.spyOn(client, "getMetasTrending").mockResolvedValue(metasTrending());
    vi.spyOn(client, "getMeta").mockResolvedValue(metaCat());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── The arithmetic ─────────────────────────────────────────────

  it("every feed tool: returned + dropped === providerReturned with no window applied", async () => {
    for (const toolId of FEED_TOOLS) {
      const data = await call(toolId);
      expect(
        data.totalMatched + totalDropped(data.droppedByFilter),
        `${toolId} envelope does not reconcile`,
      ).toBe(data.providerWindow.providerReturned);
    }
  });

  it("every feed tool: totalMatched + dropped === providerReturned even when a window IS applied", async () => {
    for (const toolId of FEED_TOOLS) {
      const data = await call(toolId, { limit: 3, chainIds: "solana" });
      expect(
        data.totalMatched + totalDropped(data.droppedByFilter),
        `${toolId} envelope does not reconcile under a window`,
      ).toBe(data.providerWindow.providerReturned);
      expect(data.returned).toBeLessThanOrEqual(3);
    }
  });

  it("trending: the same arithmetic holds on the narrative feed", async () => {
    const data = await call("dexscreener.trending", { minTokenCount: 40 });
    expect(data.totalMatched + totalDropped(data.droppedByFilter)).toBe(
      data.providerWindow.providerReturned,
    );
    expect(data.droppedByFilter.minTokenCount).toBeGreaterThan(0);
  });

  // ── No hidden defaults ─────────────────────────────────────────

  it("profile defaults are bounded and visible; other feeds return their provider window", async () => {
    for (const toolId of FEED_TOOLS) {
      const data = await call(toolId);
      if (toolId === "dexscreener.profiles" || toolId === "dexscreener.profiles.recent") {
        expect(data.returned).toBe(20);
        expect(data.filtersApplied.limit).toBe(20);
        expect(data.hasMore).toBe(true);
      } else {
        expect(data.returned).toBe(data.providerWindow.providerReturned);
        expect(data.hasMore).toBe(false);
      }
    }
  });

  // The specific defect: `attention` merged two 30-row windows and then sliced to
  // 20 with no flag and no count of what it cut.
  it("attention: the whole merge is returned, not the first 20 rows", async () => {
    const data = await call("dexscreener.attention");
    expect(data.returned).toBeGreaterThan(20);
    expect(data.returned).toBe(data.providerWindow.providerReturned);

    const capped = await call("dexscreener.attention", { limit: 20 });
    expect(capped.returned).toBe(20);
    expect(capped.hasMore).toBe(true);
    expect(capped.totalMatched).toBe(data.returned);
  });

  it("trending: omitting limit returns all 19 narratives", async () => {
    const data = await call("dexscreener.trending");
    expect(data.returned).toBe(19);
    expect(data.providerWindow.providerReturned).toBe(19);
  });

  // ── Honest provenance ──────────────────────────────────────────

  it("no feed claims a ranking DexScreener does not disclose", async () => {
    for (const toolId of FEED_TOOLS) {
      const data = await call(toolId);
      expect(data.providerWindow.providerOrder).toBe("unspecified");
    }
    const narratives = await call("dexscreener.trending");
    expect(narratives.providerWindow.providerOrder).toBe("unspecified");
    expect(narratives.providerWindow.note).toContain("NOT a ranking");
  });

  // 19 rows is a floor on the narrative endpoint's cap, not the cap — so it is not
  // reported as one, and `providerCapped` cannot be read as "there is no more".
  it("trending reports an UNKNOWN provider cap rather than borrowing the 30-row one", async () => {
    const data = await call("dexscreener.trending");
    expect(data.providerWindow.providerCap).toBeNull();
    expect(data.providerWindow.providerCapped).toBeNull();
  });

  it("feeds report the measured 30-row cap and say the rows carry no market data", async () => {
    const data = await call("dexscreener.boosts");
    expect(data.providerWindow.providerCap).toBe(30);
    expect(data.providerWindow.providerCapped).toBe(true);
    expect(data.providerWindow.note).toContain("NO price, liquidity, volume or pool address");
    expect(data.providerWindow.note).toContain("dexscreener.tokenPairs");
  });

  it("asOfMs exists on every feed, so eventAgeSeconds means something", async () => {
    for (const toolId of FEED_TOOLS) {
      const data = await call(toolId);
      expect(data.asOfMs).toBeGreaterThan(Date.UTC(2026, 0, 1));
    }
  });

  // ── O9: full text, labelled, never bounded ─────────────────────

  it("issuer descriptions are delivered whole and every carrying path is named", async () => {
    const data = await call("dexscreener.profiles.recent");
    expect(data.externalContentWarning).toContain("untrusted data");
    expect(data.externalContentFields.length).toBeGreaterThan(0);

    const source = profilesRecent();
    const longest = source.reduce(
      (best, row) => ((row.description ?? "").length > best.length ? row.description ?? "" : best),
      "",
    );
    expect(longest.length).toBeGreaterThan(500);

    // Delivered whole: the ONLY difference from what the provider sent is the
    // structural characters, which O9 explicitly still allows removing. No length
    // bound, no "…[truncated N chars]" marker, no truncatedFields array.
    const structural = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
    const expected = longest.replace(structural, "");
    const emitted = data.rows.map((row) => row.description);
    expect(emitted).toContain(expected);
    expect(expected.length).toBeGreaterThan(longest.length - 40);
    expect(JSON.stringify(data)).not.toContain("truncated");

    // And every row that carries text is enumerated by its exact dot path.
    const withText = data.rows.filter((row) => typeof row.description === "string" && row.description !== "");
    expect(data.externalContentFields.filter((path) => path.endsWith(".description"))).toHaveLength(
      withText.length,
    );
  });

  it("identity is NOT labelled as untrusted prose — the agent must act on it", async () => {
    const data = await call("dexscreener.profiles");
    const flagged = data.externalContentFields.join(" ");
    expect(flagged).not.toContain("tokenAddress");
    expect(flagged).not.toContain("chainId");
  });

  it("opt-in issuer links are labelled once requested", async () => {
    const lean = await call("dexscreener.boosts");
    expect(lean.externalContentFields.some((path) => path.endsWith(".links"))).toBe(false);
    const withLinks = await call("dexscreener.boosts", { fields: "links" });
    expect(withLinks.externalContentFields.some((path) => path.endsWith(".links"))).toBe(true);
  });

  it("structural characters are stripped from issuer text without shortening it", async () => {
    const client = getDexScreenerClient();
    const [first, ...rest] = profilesLatest();
    if (first === undefined) throw new Error("fixture has no rows");
    vi.spyOn(client, "getProfiles").mockResolvedValue([
      { ...first, description: "line one\nline two three\ttabbed" },
      ...rest,
    ]);
    const data = await call("dexscreener.profiles");
    expect(data.rows[0]?.description).toBe("line oneline twothreetabbed");
  });

  // ── The two recovered fields ───────────────────────────────────

  it("BOTH profile feeds emit updatedAt and communityTakeover, which the latest feed used to discard", async () => {
    for (const toolId of ["dexscreener.profiles", "dexscreener.profiles.recent"]) {
      const data = await call(toolId);
      const withTimestamps = data.rows.filter((row) => typeof row.updatedAt === "string");
      expect(withTimestamps, `${toolId} lost updatedAt`).toHaveLength(data.rows.length);
      const withFlag = data.rows.filter((row) => typeof row.communityTakeover === "boolean");
      expect(withFlag, `${toolId} lost the cto flag`).toHaveLength(data.rows.length);
      // The derived age is what filters and sorts read, so it must be there too.
      expect(data.rows.every((row) => typeof row.eventAgeSeconds === "number")).toBe(true);
    }
  });

  // ── openGraph: a deliberate omission, not an oversight ─────────

  it("openGraph is emitted nowhere, because it is derivable from two fields on the row", async () => {
    for (const toolId of FEED_TOOLS) {
      const data = await call(toolId, { fields: "full" });
      expect(JSON.stringify(data), `${toolId} leaked openGraph`).not.toContain("openGraph");
      expect(JSON.stringify(data)).not.toContain("/token-images/og/");
    }
  });

  // ── meta: three numbers that used to be two ────────────────────

  it("meta separates the narrative total from the subset it actually returned", async () => {
    const data = await call("dexscreener.meta", { slug: "cat" });
    const detail = metaCat();

    // Distinct fields, and neither is spelled in a way that reads as the total.
    expect(data.pairsReturned).toBe(20);
    expect(data.hasMore).toBe(true);
    expect(data.narrativeSubsetTokenCount).toBe(detail.tokenCount);
    expect(data.subsetMarketCapSumUsd).toBe(detail.marketCap);
    expect(data.marketCap).toBeUndefined();
    expect(data.tokenCount).toBeUndefined();

    // The measurement that forces the renames: this endpoint's marketCap is
    // EXACTLY the sum of the pairs it sent, and its tokenCount EXACTLY their
    // count — while trending reports far more tokens for the same slug.
    const pairSum = detail.pairs.reduce((sum, pair) => sum + (pair.marketCap ?? 0), 0);
    expect(detail.marketCap).toBe(pairSum);
    expect(detail.tokenCount).toBe(detail.pairs.length);
    const trendingCat = metasTrending().find((meta) => meta.slug === "cat");
    expect(trendingCat?.tokenCount).toBeGreaterThan(detail.pairs.length * 2);

    expect(data.narrativeSubsetNote).toContain("dexscreener.trending");
  });

  it("meta's liquidity and volume are named as the PROVIDER's aggregate, not a sum of these pairs", async () => {
    const data = await call("dexscreener.meta", { slug: "cat" });
    const detail = metaCat();
    expect(data.providerNarrativeLiquidityUsd).toBe(detail.liquidity);
    const pairLiquiditySum = detail.pairs.reduce(
      (sum, pair) => sum + (pair.liquidity?.usd ?? 0),
      0,
    );
    // They genuinely disagree, which is why the field is not called a sum.
    expect(detail.liquidity).not.toBe(pairLiquiditySum);
  });

  it("meta emits AgentDexPair rows — the legacy unit-less shape is gone with projectors.ts", async () => {
    const data = await call("dexscreener.meta", { slug: "cat" });
    const pairs = data.pairs as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(pairs)).toBe(true);
    const first = pairs?.[0];
    expect(first).toBeDefined();
    expect(first).toHaveProperty("liquidityUsd");
    expect(first).toHaveProperty("turnoverRatioH24");
    // The four unit-less names the legacy projector emitted.
    expect(first).not.toHaveProperty("fdv");
    expect(first).not.toHaveProperty("marketCap");
    expect(first).not.toHaveProperty("pairCreatedAt");
    expect(first).not.toHaveProperty("priceNative");
  });

  // ── Empty-but-diagnosable ──────────────────────────────────────

  it("a chain filter that matches nothing reports WHY, not an absent market", async () => {
    const data = await call("dexscreener.boosts", { chainIds: "arbitrum" });
    expect(data.rows).toHaveLength(0);
    expect(data.providerWindow.providerReturned).toBe(30);
    expect(data.droppedByFilter.chainIds).toBe(30);
  });

  // `cto` was `false` on 30/30 rows of both feeds the day these were captured, so
  // the live fixture proves the DROP path. The keep path is proven against the same
  // capture with one row's flag flipped — a derived variant, labelled as such,
  // rather than a hand-invented profile row.
  it("ctoOnly drops everything on a feed with no takeovers, and keeps the one that has it", async () => {
    const dropped = await call("dexscreener.profiles", { ctoOnly: true });
    expect(dropped.rows).toHaveLength(0);
    expect(dropped.droppedByFilter.ctoOnly).toBe(30);

    const client = getDexScreenerClient();
    const [first, ...rest] = profilesLatest();
    if (first === undefined) throw new Error("fixture has no rows");
    vi.spyOn(client, "getProfiles").mockResolvedValue([{ ...first, cto: true }, ...rest]);
    const kept = await call("dexscreener.profiles", { ctoOnly: true });
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]?.communityTakeover).toBe(true);
    expect(kept.droppedByFilter.ctoOnly).toBe(29);
  });

  it("a row whose event time is unknown is counted apart from one that is merely old", async () => {
    const client = getDexScreenerClient();
    const [first, ...rest] = profilesRecent();
    if (first === undefined) throw new Error("fixture has no rows");
    vi.spyOn(client, "getProfilesRecentUpdates").mockResolvedValue([
      { ...first, updatedAt: null },
      ...rest,
    ]);
    const data = await call("dexscreener.profiles.recent", { updatedWithinSeconds: 60 });
    expect(data.droppedByFilter.unknownEventAge).toBe(1);
    expect(data.totalMatched + totalDropped(data.droppedByFilter)).toBe(
      data.providerWindow.providerReturned,
    );
  });

  // ── Rejection by name ──────────────────────────────────────────

  it("a freshness filter aimed at a feed that reports no time is refused, not ignored", async () => {
    const message = await refuse("dexscreener.boosts", { updatedWithinSeconds: 60 });
    expect(message).toContain("updatedWithinSeconds");
    expect(message).toContain("no timestamp");
    expect(message).toContain("dexscreener.profiles.recent");
  });

  it("the wrong spelling of a freshness filter names the right one", async () => {
    const message = await refuse("dexscreener.communityTakeovers", { updatedWithinSeconds: 60 });
    expect(message).toContain("claimedWithinSeconds");
  });

  it("a boost threshold on a feed with no boost units is refused by name", async () => {
    const message = await refuse("dexscreener.profiles", { minBoostCountTotal: 10 });
    expect(message).toContain("minBoostCountTotal");
    expect(message).toContain("dexscreener.boosts");
  });

  it("chainIds on the narrative feed is refused, because a narrative has no chain", async () => {
    const message = await refuse("dexscreener.trending", { chainIds: "solana" });
    expect(message).toContain("chainIds");
    expect(message).toContain("cross-chain theme");
  });

  // ── attention: the fabricated zero is gone ─────────────────────

  it("a profile-only row reports UNKNOWN boost units, not a measured zero", async () => {
    const data = await call("dexscreener.attention");
    const profileOnly = data.rows.filter((row) => row.hasProfile === true && row.boostCountTotal === null);
    expect(profileOnly.length).toBeGreaterThan(0);
    // Absence from a capped 30-row boost window is not a measurement of zero.
    expect(data.rows.some((row) => row.boostCountTotal === 0)).toBe(false);
  });

  it("attention still ranks paid rows above unpaid ones despite the null", async () => {
    const data = await call("dexscreener.attention");
    const totals = data.rows.map((row) => row.boostCountTotal);
    const firstNull = totals.indexOf(null);
    expect(firstNull).toBeGreaterThan(0);
    expect(totals.slice(firstNull).every((value) => value === null)).toBe(true);
  });
});
