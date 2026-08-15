import { describe, it, expect } from "vitest";
import type { ProtocolToolManifest } from "../../../vex-agent/tools/protocols/types.js";
import { DEXSCREENER_TOOLS } from "../../../vex-agent/tools/protocols/dexscreener/manifest.js";

function toolById(toolId: string): ProtocolToolManifest {
  const tool = DEXSCREENER_TOOLS.find(t => t.toolId === toolId);
  if (tool === undefined) throw new Error(`no manifest declares ${toolId}`);
  return tool;
}

function descriptionOf(toolId: string): string {
  return toolById(toolId).description;
}

function passageOf(toolId: string): string {
  const passage = toolById(toolId).discovery?.embeddingText;
  if (passage === undefined) throw new Error(`no embeddingText for ${toolId}`);
  return passage;
}

function paramKeys(toolId: string): string[] {
  return toolById(toolId).params.map((param) => param.key);
}

describe("dexscreener manifest", () => {
  // ── Completeness ─────────────────────────────────────────────────

  it("has 14 tools total", () => {
    expect(DEXSCREENER_TOOLS).toHaveLength(14);
  });

  const EXPECTED_TOOL_IDS = [
    // Core (4)
    "dexscreener.search",
    "dexscreener.pairs",
    "dexscreener.tokens",
    "dexscreener.tokenPairs",
    // Trending / attention / narratives (8)
    "dexscreener.profiles",
    "dexscreener.profiles.recent",
    "dexscreener.boosts",
    "dexscreener.boosts.top",
    "dexscreener.communityTakeovers",
    "dexscreener.attention",
    "dexscreener.trending",
    "dexscreener.meta",
    // Orders & Ads (2)
    "dexscreener.orders",
    "dexscreener.ads",
  ];

  it("expected toolId count matches manifest count", () => {
    expect(EXPECTED_TOOL_IDS).toHaveLength(14);
  });

  for (const toolId of EXPECTED_TOOL_IDS) {
    it(`declares ${toolId}`, () => {
      const tool = DEXSCREENER_TOOLS.find(t => t.toolId === toolId);
      expect(tool).toBeDefined();
    });
  }

  it("has no tools beyond expected list", () => {
    const expectedSet = new Set(EXPECTED_TOOL_IDS);
    const unexpected = DEXSCREENER_TOOLS.filter(t => !expectedSet.has(t.toolId));
    expect(unexpected).toHaveLength(0);
  });

  // ── Namespace ────────────────────────────────────────────────────

  it("all tools belong to dexscreener namespace", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.namespace).toBe("dexscreener");
    }
  });

  it("all tools are active lifecycle", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.lifecycle).toBe("active");
    }
  });

  it("all toolIds start with dexscreener.", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.toolId).toMatch(/^dexscreener\./);
    }
  });

  // ── Mutating flags (all read-only) ────────────────────────────────

  it("all tools are read-only (not mutating)", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.mutating).toBe(false);
    }
  });

  it("has zero mutating tools", () => {
    const mutating = DEXSCREENER_TOOLS.filter(t => t.mutating);
    expect(mutating).toHaveLength(0);
  });

  // ── Required params ──────────────────────────────────────────────

  it("dexscreener.search requires query", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.search")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toEqual(["query"]);
  });

  it("dexscreener.pairs requires chain, pairAddress", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.pairs")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("pairAddress");
  });

  it("dexscreener.tokens requires chain, tokenAddresses", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.tokens")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("tokenAddresses");
  });

  it("dexscreener.tokenPairs requires chain, tokenAddress", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.tokenPairs")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("tokenAddress");
  });

  it("dexscreener.tokenPairs declares an optional numeric limit", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.tokenPairs")!;
    const limit = tool.params.find(p => p.key === "limit");
    expect(limit).toBeDefined();
    expect(limit!.type).toBe("number");
    // Optional: limit must NOT be required (no hardcoded default; omit ⇒ all pairs).
    expect(limit!.required).toBeFalsy();
  });

  it("advertises a compact discovery-oriented search surface", () => {
    expect(paramKeys("dexscreener.search")).toEqual([
      "query",
      "chainIds",
      "limit",
      "offset",
      "fields",
      "quoteSymbols",
      "minLiquidityUsd",
      "minTurnoverRatio",
      "requirePriceUsd",
      "explainDrops",
    ]);
  });

  it("advertises only non-destructive snapshot shaping on tokens", () => {
    expect(paramKeys("dexscreener.tokens")).toEqual([
      "chain",
      "tokenAddresses",
      "limit",
      "offset",
      "fields",
      "window",
      "includeAllWindows",
    ]);
  });

  it("keeps advanced screening on tokenPairs and meta without omitFields", () => {
    for (const toolId of ["dexscreener.tokenPairs", "dexscreener.meta"]) {
      const keys = paramKeys(toolId);
      expect(keys).toContain("sortBy");
      expect(keys).toContain("minLiquidityUsd");
      expect(keys).toContain("minTurnoverRatio");
      expect(keys).toContain("explainDrops");
      expect(keys).not.toContain("omitFields");
    }
  });

  it("describes raw and requested-token-normalized prices without ambiguity", () => {
    for (const toolId of [
      "dexscreener.search",
      "dexscreener.pairs",
      "dexscreener.tokens",
      "dexscreener.tokenPairs",
      "dexscreener.meta",
    ]) {
      expect(descriptionOf(toolId)).toMatch(/raw priceUsd.*base token/i);
    }
    expect(descriptionOf("dexscreener.tokenPairs")).toContain("requestedTokenSide");
    expect(descriptionOf("dexscreener.tokenPairs")).toContain("requestedTokenPriceUsd");
  });

  it("dexscreener.orders requires chain, tokenAddress", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.orders")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("tokenAddress");
  });

  it("dexscreener.profiles has no required params", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.profiles")!;
    const required = tool.params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  it("dexscreener.boosts has no required params", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.boosts")!;
    const required = tool.params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  it("dexscreener.boosts.top has no required params", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.boosts.top")!;
    const required = tool.params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  it("dexscreener.communityTakeovers has no required params", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.communityTakeovers")!;
    const required = tool.params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  it("dexscreener.attention has no required params", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.attention")!;
    const required = tool.params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  it("dexscreener.trending (narratives) has no required params", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.trending")!;
    const required = tool.params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  it("dexscreener.profiles.recent has no required params", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.profiles.recent")!;
    const required = tool.params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  it("dexscreener.meta requires slug", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.meta")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toEqual(["slug"]);
  });

  it("dexscreener.ads has no required params", () => {
    const tool = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.ads")!;
    const required = tool.params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  // ── No requiresEnv (DexScreener is free) ─────────────────────────

  it("no tools require ENV", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.requiresEnv).toBeUndefined();
    }
  });

  // ── Descriptions quality ──────────────────────────────────────────

  it("every tool has non-empty description", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(15);
    }
  });

  it("every param has non-empty description", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      for (const param of tool.params) {
        expect(param.description.length).toBeGreaterThan(3);
      }
    }
  });

  // ── Retrieval metadata ───────────────────────────────────────────

  it("every tool has retrieval-only embedding text", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      expect(
        tool.discovery?.embeddingText,
        `${tool.toolId} missing discovery.embeddingText`,
      ).toBeTruthy();
      expect(tool.discovery!.embeddingText!.length).toBeGreaterThan(80);
    }
  });

  // Note: assertions check intent-level content the agent-style refactor
  // preserves. Implementation-detail phrases ("pair analytics", "Batch
  // lookup", "marketing legitimacy", "unified DEX Screener trending
  // discovery") were API-doc jargon and were intentionally replaced with
  // user-intent phrasing in the new passages.

  it("core market-data embeddings capture search, pair, token, and liquidity intent", () => {
    const search = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.search")!;
    const pairs = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.pairs")!;
    const tokens = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.tokens")!;
    const tokenPairs = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.tokenPairs")!;
    expect(search.discovery?.embeddingText).toContain("Search DexScreener-indexed trading pairs");
    expect(search.discovery?.embeddingText).toContain("contract address");
    expect(pairs.discovery?.embeddingText).toContain("Full analytics");
    expect(pairs.discovery?.embeddingText).toContain("liquidity");
    expect(tokens.discovery?.embeddingText).toContain("up to 60 token contract addresses");
    expect(tokens.discovery?.embeddingText?.toLowerCase()).toContain("batch pricing");
    expect(tokenPairs.discovery?.embeddingText).toContain("pools and trading pairs");
    expect(tokenPairs.discovery?.embeddingText).toContain("shortlist liquidity");
  });

  it("trend embeddings capture boosted, profile, community takeover, attention, and narrative intent", () => {
    const profiles = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.profiles")!;
    const profilesRecent = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.profiles.recent")!;
    const boosts = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.boosts")!;
    const topBoosts = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.boosts.top")!;
    const communityTakeovers = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.communityTakeovers")!;
    const attention = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.attention")!;
    const trending = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.trending")!;
    const meta = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.meta")!;
    expect(profiles.discovery?.embeddingText).toContain("latest token PROFILE METADATA");
    expect(profiles.discovery?.embeddingText?.toLowerCase()).toContain("not a token-creation");
    expect(profilesRecent.discovery?.embeddingText?.toLowerCase()).toContain("recently updated");
    expect(boosts.discovery?.embeddingText).toContain("latest tokens that received paid boosts");
    expect(boosts.discovery?.embeddingText?.toLowerCase()).toContain("promoted");
    expect(topBoosts.discovery?.embeddingText).toContain("most active boosts");
    expect(topBoosts.discovery?.embeddingText?.toLowerCase()).toContain("ranked by total boost amount");
    expect(communityTakeovers.discovery?.embeddingText).toContain("community takeover");
    expect(communityTakeovers.discovery?.embeddingText).toContain("CTO");
    // Synthetic attention merge (renamed from the old synthetic "trending").
    expect(attention.discovery?.embeddingText?.toLowerCase()).toContain("attention");
    expect(attention.discovery?.embeddingText?.toLowerCase()).toContain("boost");
    // Official trending feed now = NARRATIVES/themes, not individual tokens.
    expect(trending.discovery?.embeddingText?.toLowerCase()).toContain("trending narratives");
    expect(trending.discovery?.embeddingText?.toLowerCase()).toContain("narratives, not individual tokens");
    // Narrative detail drill-down.
    expect(meta.discovery?.embeddingText?.toLowerCase()).toContain("narrative");
    expect(meta.discovery?.embeddingText?.toLowerCase()).toContain("slug");
  });

  it("orders and ads embeddings capture paid promotion verification intent", () => {
    const orders = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.orders")!;
    const ads = DEXSCREENER_TOOLS.find(t => t.toolId === "dexscreener.ads")!;
    expect(orders.discovery?.embeddingText).toContain("paid promotional orders");
    expect(orders.discovery?.embeddingText?.toLowerCase()).toContain("marketing");
    expect(ads.discovery?.embeddingText).toContain("ad placements");
    expect(ads.discovery?.embeddingText?.toLowerCase()).toContain("visibility");
  });

  // ── The honest client-side-window disclosure (D-3) ────────────────
  //
  // Every windowed tool must SAY that its filters, sorts and windows run in
  // Vex over rows DexScreener already chose. Without it a filtered-to-empty
  // answer reads to a context-free agent as "this does not exist", which is
  // the failure `droppedByFilter` exists to prevent — and the description is
  // the only place the agent reads before it calls.
  //
  // Pinned as the load-bearing FRAGMENT of each tool's clause, not the whole
  // string, so prose stays editable while the claim cannot silently drift.
  // Each family's number differs and is measured, not assumed: the pair/feed
  // families are capped at 30 by the provider, `meta` is not (31 rows
  // observed), `trending` returns a provider-chosen size, the takeover feed
  // has only an observed bound, and `attention` merges two ≤30 windows.

  const WINDOW_CLAUSE_FRAGMENTS: readonly (readonly [string, string])[] = [
    ["dexscreener.search", "at most 30 provider-chosen rows per call"],
    ["dexscreener.tokens", "at most 30 provider-chosen rows per call"],
    ["dexscreener.tokenPairs", "at most 30 pools per token"],
    ["dexscreener.pairs", "returns only the pool(s) you name"],
    ["dexscreener.profiles", "feed window of at most 30 rows per call"],
    ["dexscreener.profiles.recent", "feed window of at most 30 rows per call"],
    ["dexscreener.boosts", "feed window of at most 30 rows per call"],
    ["dexscreener.boosts.top", "feed window of at most 30 rows per call"],
    ["dexscreener.ads", "feed window of at most 30 rows per call"],
    ["dexscreener.communityTakeovers", "observed ≤30 rows"],
    ["dexscreener.trending", "whose size the provider chooses"],
    ["dexscreener.meta", "can exceed 30 rows"],
    ["dexscreener.attention", "each ≤30 provider-chosen rows"],
  ];

  for (const [toolId, fragment] of WINDOW_CLAUSE_FRAGMENTS) {
    it(`${toolId} description discloses its client-side window`, () => {
      expect(descriptionOf(toolId)).toContain(fragment);
    });
  }

  it("every windowed tool states that no server-side option exists", () => {
    for (const [toolId] of WINDOW_CLAUSE_FRAGMENTS) {
      expect(descriptionOf(toolId), `${toolId} description`).toMatch(/no server-side/i);
    }
  });

  // `orders` is a per-token record lookup with no window at all: the clause
  // would itself be a false statement there, so its ABSENCE is pinned.
  it("dexscreener.orders carries no window clause (it has no window)", () => {
    const orders = descriptionOf("dexscreener.orders");
    expect(orders).not.toMatch(/no server-side/i);
    expect(orders).not.toContain("at most 30");
    expect(orders).not.toContain("provider-chosen rows");
    expect(orders).not.toContain("feed window");
  });

  it("dexscreener.attention names only the profile and boost windows it merges", () => {
    const attention = descriptionOf("dexscreener.attention");
    expect(attention).toContain("token-profile");
    expect(attention).toContain("paid-boost");
    // attention-merge.ts joins /token-profiles/latest/v1 and
    // /token-boosts/latest/v1 — the ad feed is NOT part of the merge.
    expect(attention).not.toMatch(/\bads?\b/i);
  });

  // ── Descriptions must not contradict the runtime (D-3) ────────────

  it("dexscreener.search names chainIds and never the rejected singular chainId", () => {
    const search = descriptionOf("dexscreener.search");
    expect(search).toContain("chainIds");
    // Word-boundary, not substring: `chainIds` contains `chainId`, so a plain
    // `toContain` check would pass while the description still taught the
    // spelling the param reader hard-rejects (pair-list/list-query.ts).
    expect(search).not.toMatch(/\bchainId\b/);
  });

  it("dexscreener.search no longer claims a liquidity sort", () => {
    const search = descriptionOf("dexscreener.search");
    expect(search).not.toContain("sorted by liquidity");
    expect(search.toLowerCase()).toContain("relevance");
  });

  it("search query text no longer promises pool-address uniqueness", () => {
    // Falsified live in the persona gate: one EVM pool address returned rows on
    // ethereum AND pulsechain. EVM addresses recur across chains.
    const query = toolById("dexscreener.search").params.find(p => p.key === "query");
    if (query === undefined) throw new Error("search has no query param");
    expect(query.description).not.toContain("exactly that one pool");
    expect(query.description).toContain("more than one chain");
  });

  it("dexscreener.trending names its single change field and the selecting window", () => {
    // Falsified live: the default row carries exactly one change field,
    // marketCapChangePctSelected, resolved against `window` (default h24) —
    // not plural "change windows".
    const trending = descriptionOf("dexscreener.trending");
    expect(trending).not.toContain("change windows");
    expect(trending).toContain("marketCapChangePctSelected");
    expect(trending).toContain("default h24");
  });

  it("dexscreener.profiles does not claim to be a trending feed", () => {
    // Three-way retrieval collision with `trending` and `attention`: this feed
    // is the latest token-profile listing, per-chain and freshness-boundable.
    expect(descriptionOf("dexscreener.profiles")).not.toMatch(/trending/i);
    expect(descriptionOf("dexscreener.profiles")).toContain("chainIds");
    expect(descriptionOf("dexscreener.profiles")).toContain("updatedWithinSeconds");
  });

  it("dexscreener.communityTakeovers makes no price prediction", () => {
    const cto = descriptionOf("dexscreener.communityTakeovers");
    expect(cto).not.toContain("precedes price action");
    expect(cto).not.toMatch(/strong trading signal/i);
  });

  it("dexscreener.orders is framed as a spend record, not a legitimacy check", () => {
    const orders = descriptionOf("dexscreener.orders");
    expect(orders).toContain("paid DEX Screener for");
    expect(orders).not.toMatch(/legitimac|legitimate/i);
  });

  // ── Retrieval passages carry the same corrections (D-3) ───────────
  //
  // The passage is what dense retrieval matches on, so a falsehood left here
  // keeps being taught even after the description is fixed. DexScreener's
  // metadata declares no aliases or exampleIntents, so these pin bounded
  // semantic claims in `embeddingText` itself.

  it("orders passage no longer frames paid promotion as a legitimacy check", () => {
    const passage = passageOf("dexscreener.orders");
    expect(passage).toContain("never evidence");
    expect(passage).toContain("legitimacy");
  });

  it("community-takeover passage no longer predicts price action", () => {
    expect(passageOf("dexscreener.communityTakeovers")).not.toContain("precedes price action");
  });

  it("search passage no longer claims results are sorted by liquidity", () => {
    expect(passageOf("dexscreener.search")).not.toContain("sorted by liquidity");
  });

  it("both profile passages refuse to masquerade as fresh-token discovery", () => {
    for (const toolId of ["dexscreener.profiles", "dexscreener.profiles.recent"]) {
      const passage = passageOf(toolId);
      expect(passage.toLowerCase(), `${toolId} passage`).not.toContain("find new tokens");
      expect(passage.toLowerCase(), `${toolId} passage`).toMatch(/metadata|profile/);
    }
  });

  it("profiles.recent passage keeps its change-feed meaning", () => {
    const passage = passageOf("dexscreener.profiles.recent");
    expect(passage).toContain("updatedAt");
    expect(passage.toLowerCase()).toContain("community-takeover");
  });
});
