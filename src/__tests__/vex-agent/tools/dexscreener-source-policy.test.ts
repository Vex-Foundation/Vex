import { describe, expect, it } from "vitest";

import { buildProtocolsPrompt } from "../../../vex-agent/engine/prompts/protocols.js";
import { DEXSCREENER_CORE_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/dexscreener/core.js";
import { DEXSCREENER_ORDERS_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/dexscreener/orders.js";
import { DEXSCREENER_TRENDING_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/dexscreener/trending.js";
import { MARKET_PROTOCOL_NAVIGATION } from "../../../vex-agent/tools/protocols/navigation/entries-market.js";
import { discoverProtocolCapabilities } from "../../../vex-agent/tools/protocols/runtime.js";

function discoveryText(
  metadata: { readonly embeddingText: string },
): string {
  return metadata.embeddingText.toLowerCase();
}

describe("DexScreener agent source policy", () => {
  it("defines the provider's authority and the identity-first research boundary", () => {
    // Wave 2: the Token Research Map left the research layer. DexScreener's
    // authority and limits now render in its `### dexscreener` declaration and
    // the research task shape of the protocols layer (inventory rows
    // T851-T862).
    const prompt = buildProtocolsPrompt();
    const section = (prompt.split("### dexscreener\n")[1]?.split("\n### ")[0] ?? "").toLowerCase();

    expect(section).toContain("read-only market research for indexed automated-market-maker pairs");
    expect(section).toContain("does not establish contract safety");
    expect(section).toContain("a missing row does not prove that no market exists");
    expect(section).toContain("resolve a name or symbol to an exact chain and contract address");
    expect(section).toContain("canonical identity from a ticker");
    expect(section).toContain("not a fresh executable quote");
    expect(section).toContain("executable price");
    // The declaration teaches no tool name at all: a DexScreener tool becomes
    // callable only through `ToolSearch`, so neither a dotted toolId (the
    // internal/audit identity the catalog rejects as a call) nor a publicName
    // can be taught here by accident.
    expect(section).not.toMatch(/dexscreener\.[a-z]/);
    expect(section).not.toContain("dexscreener__");

    const research = (prompt.split("### Research\n")[1]?.split("\n### ")[0] ?? "").toLowerCase();
    expect(research).toContain("dexscreener indexing lags by minutes to hours for brand-new tokens");
    expect(research).toContain("use dexscreener afterwards for depth and price sanity");
  });

  it("renders the same boundaries in namespace navigation", () => {
    const navigation = MARKET_PROTOCOL_NAVIGATION.find((entry) => entry.namespace === "dexscreener");
    expect(navigation).toBeDefined();

    const rendered = [
      navigation!.summary,
      navigation!.whenToUse,
      navigation!.preferInstead,
      ...navigation!.facets.map((facet) => facet.summary),
    ].join(" ").toLowerCase();

    expect(rendered).toContain("token address + chain -> `tokenpairs`");
    expect(rendered).toContain("name/symbol -> `search`");
    expect(rendered).toContain("narrative -> `trending`, then `meta`");
    expect(rendered).toContain("promotion -> `boosts`/`ads`, then per-token `orders`");
    expect(rendered).toContain("profiles report metadata updates, not token creation");
    expect(rendered).toContain("cto is a provider label, not proof");
    expect(rendered).toContain("live undocumented feeds influenced by engagement and promotion");
    expect(rendered).toContain("always request a fresh quote");
  });

  it("does not retrieve profiles as token creation or CTO as proof of control", () => {
    const profiles = discoveryText(DEXSCREENER_TRENDING_DISCOVERY["dexscreener.profiles"]);
    const cto = discoveryText(DEXSCREENER_TRENDING_DISCOVERY["dexscreener.communityTakeovers"]);

    expect(profiles).toContain("not a token-creation, launch, or newly listed pair feed");
    // The merged passage carries the retired recent-feed's honesty too.
    expect(profiles).toContain("does not show when a token or pair was created");
    expect(cto).toContain("provider classification");
    expect(cto).toContain("not proof that ownership, admin keys, or contract control changed");
    expect(cto).not.toContain("community has reclaimed control");
  });

  it("labels narrative feeds as undocumented and promotion-influenced", () => {
    const trending = discoveryText(DEXSCREENER_TRENDING_DISCOVERY["dexscreener.trending"]);
    const meta = discoveryText(DEXSCREENER_TRENDING_DISCOVERY["dexscreener.meta"]);

    for (const text of [trending, meta]) {
      expect(text).toContain("live but undocumented");
      expect(text).toMatch(/engagement.*promotion|promotion.*engagement/);
      expect(text).not.toContain("official dex screener");
    }
    expect(trending).toContain("returns narratives, not individual tokens");
    expect(trending).toContain("always drill into a selected slug with dexscreener.meta");
  });

  it("keeps pair research, promotion, safety, and execution claims separate", () => {
    const search = discoveryText(DEXSCREENER_CORE_DISCOVERY["dexscreener.search"]);
    const tokenPairs = discoveryText(DEXSCREENER_CORE_DISCOVERY["dexscreener.tokenPairs"]);
    const orders = discoveryText(DEXSCREENER_ORDERS_DISCOVERY["dexscreener.orders"]);

    expect(search).toContain("a ticker match is not token identity");
    expect(search).toContain("select an exact chain and contract address");
    expect(tokenPairs).toContain("fresh executable quote from the actual venue");
    expect(orders).toContain("never evidence of demand, legitimacy, or contract safety");
  });
});

describe("DexScreener discovery routing", () => {
  it.each([
    ["find a token by name or symbol", "dexscreener.search"],
    ["inspect a known pool address", "dexscreener.pairs"],
    ["batch market data for multiple exact token addresses", "dexscreener.tokens"],
    ["compare indexed pools for one exact token address on a chain", "dexscreener.tokenPairs"],
    ["trending crypto narratives", "dexscreener.trending"],
    ["pairs inside a selected narrative slug", "dexscreener.meta"],
    ["latest paid token boosts", "dexscreener.boosts"],
    ["current token ad placements", "dexscreener.ads"],
    ["promotion orders for this exact token", "dexscreener.orders"],
  ])("routes %s to %s", async (query, expectedToolId) => {
    const result = await discoverProtocolCapabilities({
      namespace: "dexscreener",
      query,
      limit: 3,
    });

    expect(result.success).toBe(true);
    expect(result.tools[0]?.toolId).toBe(expectedToolId);
  });
});

/**
 * The regression PR #90 exists to fix, pinned NEGATIVELY: the synthetic
 * attention merge must not outrank the provider feeds on ordinary trending
 * or promotion queries, and must remain reachable when explicitly requested.
 * A positive-only routing table cannot catch this class of regression - the
 * collision that motivated the fix passed every positive case.
 */
describe("DexScreener attention demotion", () => {
  it.each([
    "what is trending right now",
    "trending meme narratives",
    "which tokens are being promoted today",
  ])("does not put the synthetic attention merge first for %s", async (query) => {
    const result = await discoverProtocolCapabilities({
      namespace: "dexscreener",
      query,
      limit: 3,
    });

    expect(result.success).toBe(true);
    expect(result.tools[0]?.toolId).toBeDefined();
    expect(result.tools[0]?.toolId).not.toBe("dexscreener.attention");
  });

  it("still routes an explicit synthetic-merge request to attention", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "dexscreener",
      query: "vex synthetic profile plus boost merge",
      limit: 3,
    });

    expect(result.success).toBe(true);
    expect(result.tools[0]?.toolId).toBe("dexscreener.attention");
  });
});
