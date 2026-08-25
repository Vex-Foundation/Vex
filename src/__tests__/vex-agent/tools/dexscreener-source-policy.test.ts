/**
 * DexScreener agent source policy, after the S3.5 retirement.
 *
 * WHAT THIS FILE LOST AND WHY. Its previous body proved honesty properties of
 * the 12 public-API tools: that profiles were not a token-creation feed, that
 * the CTO label was not proof of control, that the synthetic attention merge
 * did not outrank the real feeds. Those tools were retired whole and
 * alias-free (owner decision D-DS2), so the claims have no subject left and
 * the assertions are deleted rather than weakened. The properties that
 * SURVIVE, because they belong to the namespace and not to any one tool, are
 * kept and retargeted here:
 *
 *  1. the prompt declaration states the provider's authority and its limits,
 *     and teaches no callable tool name;
 *  2. the navigation entry renders the same boundaries and routes correctly;
 *  3. retrieval passages keep identity, promotion and execution claims apart.
 */

import { describe, expect, it } from "vitest";

import { buildProtocolsPrompt } from "../../../vex-agent/engine/prompts/protocols.js";
import { PROTOCOL_TOOLS } from "../../../vex-agent/tools/protocols/catalog.js";
import { DEXSCREENER_RESOLVE_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/dexscreener/resolve.js";
import { DEXSCREENER_MARKET_CONTEXT_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/dexscreener/market-context.js";
import { MARKET_PROTOCOL_NAVIGATION } from "../../../vex-agent/tools/protocols/navigation/entries-market.js";
import { discoverProtocolCapabilities } from "../../../vex-agent/tools/protocols/runtime.js";

function discoveryText(
  metadata: { readonly embeddingText: string },
): string {
  return metadata.embeddingText.toLowerCase();
}

describe("DexScreener agent source policy", () => {
  it("defines the provider's authority and the identity-first research boundary", () => {
    const prompt = buildProtocolsPrompt();
    const section = (prompt.split("### dexscreener\n")[1]?.split("\n### ")[0] ?? "").toLowerCase();

    expect(section).toContain("read-only market research for indexed automated-market-maker pairs");
    // CONTRACT CHANGE, stage S4. This assertion used to pin "does not
    // establish contract safety", which was true while the namespace had no
    // safety surface at all. `dexscreener__pair_details_get` now relays GoPlus
    // and QuickIntel audits, holder distribution and LP locks, so repeating the
    // old sentence would route the model away from a tool that exists. The
    // replacement pins the narrower claim that is still true and is the one
    // that matters: the namespace RELAYS third-party audit evidence rather than
    // performing an audit, and an absent block is unknown rather than clean.
    expect(section).toContain("audit blocks come from third parties and a missing one reads unavailable, never clean");
    expect(section).toContain("trader figures are venue-local cash flow and holdings, never profit");
    expect(section).toContain("a missing row does not prove that no market exists");
    expect(section).toContain("resolve a name or ticker symbol to an exact chain and contract address");
    expect(section).toContain("canonical identity from a ticker");
    expect(section).toContain("not a fresh executable quote");
    expect(section).toContain("executable price");
    // CONTRACT CHANGE, source-hierarchy card (owner order 2026-08-25). This
    // used to assert the declaration teaches NO tool name, on the rationale
    // that a DexScreener tool becomes callable only through `ToolSearch`.
    // D-DS9 made that rationale false: every dexscreener schema is injected
    // into each request's tools array, so the declaration now MUST teach the
    // publicNames or the model pays a discovery round it never needed. The
    // new pin: the "Always loaded" line exists and lists EXACTLY the
    // advertised dexscreener publicNames, in catalog order, so the prompt can
    // never advertise a tool the tools array does not carry. Dotted toolIds
    // (an identity the catalog rejects as a call) remain banned.
    expect(section).not.toMatch(/dexscreener\.[a-z]/);
    const advertisedNames = PROTOCOL_TOOLS
      .filter((tool) => tool.namespace === "dexscreener")
      .map((tool) => tool.publicName);
    expect(advertisedNames).toHaveLength(18);
    const alwaysLoadedLine = section
      .split("\n")
      .find((line) => line.startsWith("always loaded:"));
    expect(alwaysLoadedLine).toBeDefined();
    for (const name of advertisedNames) {
      expect(alwaysLoadedLine).toContain(`\`${name}\``);
    }
    expect(alwaysLoadedLine).toContain("no toolsearch round needed");

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
    expect(rendered).toContain("name or symbol -> `search`");
    expect(rendered).toContain("`trending` (narratives)");
    expect(rendered).toContain("who is paying for visibility -> `spotlight`");
    expect(rendered).toContain("a boost is bought visibility rather than demand");
    expect(rendered).toContain("not organic or genuine rankings");
    expect(rendered).toContain("always request a fresh quote");
  });

  it("keeps identity, promotion, and execution claims separate in the passages", () => {
    const search = discoveryText(DEXSCREENER_RESOLVE_DISCOVERY["dexscreener.search"]);
    const tokenPairs = discoveryText(DEXSCREENER_RESOLVE_DISCOVERY["dexscreener.tokenPairs"]);
    const spotlight = discoveryText(DEXSCREENER_RESOLVE_DISCOVERY["dexscreener.spotlight"]);
    const narratives = discoveryText(DEXSCREENER_MARKET_CONTEXT_DISCOVERY["dexscreener.trending"]);

    // Identity is never inferred from a ticker.
    expect(search).toContain("a ticker is not identity");
    expect(search).toContain("verify by address");
    // The pool list is routing input, and says the window is bounded.
    expect(tokenPairs).toContain("within the provider's returned window");
    expect(tokenPairs).toContain("the routing input before any swap");
    // Paid attention is never demand.
    expect(spotlight).toContain("a boost is bought visibility");
    expect(spotlight).toMatch(/organic momentum lives in/);
    // Narratives are aggregates and hand off by id, not by slug.
    expect(narratives).toContain("individual pairs live in the screening tools");
    // The exact wording is the coordinator's to author under D-DS7 and it was
    // reworded in S8; what this pins is the semantic fact, which did not change:
    // the hand-off value is the narrative ID, not its slug.
    expect(narratives).toContain("narrative id the screening tools");

    // No passage on this surface may promise an executable price.
    for (const text of [search, tokenPairs, spotlight, narratives]) {
      expect(text).not.toContain("executable quote");
      expect(text).not.toContain("official dex screener");
    }
  });
});

describe("DexScreener discovery routing", () => {
  it.each([
    ["find a token by name or symbol", "dexscreener.search"],
    ["where does this token trade and how is liquidity split across dexes", "dexscreener.tokenPairs"],
    ["which meta or narrative sector is moving", "dexscreener.trending"],
    ["current live state of one known pool address", "dexscreener.pair.get"],
    ["refresh a watchlist of addresses I already have", "dexscreener.pairs.batch"],
    ["latest paid token boosts", "dexscreener.spotlight"],
    ["which chains and dexes are indexed", "dexscreener.chains"],
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
 * The narratives tool answers "which THEME is moving". The pair boards answer
 * "which PAIRS are moving". They compete for the same vocabulary, and the
 * collision is the reason `dexscreener.trending` was renamed to
 * `dexscreener__narratives_list` in the first place, so it is pinned
 * negatively as well as positively.
 */
describe("DexScreener narrative and pair-board separation", () => {
  it.each([
    "what tokens are trending right now",
    "which pairs have the most volume today",
    "biggest gainers in the last hour",
  ])("does not put the narrative aggregate first for %s", async (query) => {
    const result = await discoverProtocolCapabilities({
      namespace: "dexscreener",
      query,
      limit: 3,
    });

    expect(result.success).toBe(true);
    expect(result.tools[0]?.toolId).toBeDefined();
    expect(result.tools[0]?.toolId).not.toBe("dexscreener.trending");
  });

  it("still routes an explicit narrative request to the narratives tool", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "dexscreener",
      query: "which narrative or meta sector is moving",
      limit: 3,
    });

    expect(result.success).toBe(true);
    expect(result.tools[0]?.toolId).toBe("dexscreener.trending");
  });
});
