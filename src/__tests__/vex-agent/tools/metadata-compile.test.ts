/**
 * Tests for compileToolDiscoveryMetadata — inheritance, override, and merge.
 */

import { describe, it, expect } from "vitest";
import { compileToolDiscoveryMetadata } from "../../../vex-agent/tools/protocols/metadata-compile.js";
import type { ProtocolToolManifest } from "../../../vex-agent/tools/protocols/types.js";
import type { ProtocolNamespaceNavigation } from "../../../vex-agent/tools/protocols/navigation/types.js";

// ── Test fixtures ──────────────────────────────────────────────

const MOCK_NAV: ProtocolNamespaceNavigation = {
  namespace: "dexscreener",
  advertised: true,
  groupId: "market-research",
  groupLabel: "Market research",
  summary: "DexScreener token and pair analytics.",
  whenToUse: "Use for token research.",
  exampleQueries: ['discover_tools(query="trending tokens")'],
  aliases: ["dex screener", "token research"],
  discoveryHints: ["pair analytics", "trending tokens"],
  facets: [
    {
      label: "Pairs and tokens",
      summary: "Inspect pairs and token contracts.",
      toolPrefixes: ["dexscreener.pairs", "dexscreener.tokens"],
      hints: ["pair analytics", "token contract"],
    },
    {
      label: "Trending",
      summary: "Find trending markets.",
      toolPrefixes: ["dexscreener.trending"],
      hints: ["trending tokens", "boosted tokens"],
    },
  ],
};

function makeManifest(overrides: Partial<ProtocolToolManifest> = {}): ProtocolToolManifest {
  return {
    toolId: "dexscreener.tokens.get",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "Get token pair analytics.",
    mutating: false,
    actionKind: "read",
    params: [{ key: "tokenAddress", type: "string", required: true, description: "Token address." }],
    exampleParams: { tokenAddress: "0x123" },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("compileToolDiscoveryMetadata", () => {
  it("inherits all defaults from namespace and facet when discovery is undefined", () => {
    const manifest = makeManifest();
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    expect(result.aliases).toEqual(expect.arrayContaining(["dex screener", "token research"]));
    expect(result.ecosystems).toEqual(["multichain"]);
    expect(result.sourceClass).toBe("specialized_market");
    expect(result.sideEffectLevel).toBe("none");
    expect(result.operation).toEqual(["research"]);
    expect(result.paramKeywords).toEqual(["tokenAddress"]);
    expect(result.exampleIntents).toEqual(expect.arrayContaining(["pair analytics", "token contract"]));
  });

  it("tool discovery.canonicalSummary overrides inherited undefined", () => {
    const manifest = makeManifest({
      discovery: { canonicalSummary: "Fetch threaded comments with depth." },
    });
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    expect(result.canonicalSummary).toBe("Fetch threaded comments with depth.");
    expect(result.ecosystems).toEqual(["multichain"]);
    expect(result.aliases).toEqual(expect.arrayContaining(["dex screener"]));
  });

  it("partial override merges arrays — tool ecosystems extend namespace ecosystems", () => {
    const manifest = makeManifest({
      discovery: { ecosystems: ["ethereum"], aliases: ["pair research"] },
    });
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    expect(result.ecosystems).toEqual(expect.arrayContaining(["multichain", "ethereum"]));
    expect(result.aliases).toEqual(expect.arrayContaining(["dex screener", "token research", "pair research"]));
    expect(result.sourceClass).toBe("specialized_market");
  });

  it("tool without matching facet still gets namespace defaults", () => {
    const manifest = makeManifest({
      toolId: "dexscreener.orders.get",
      params: [{ key: "chainId", type: "string", required: true, description: "Chain ID." }],
    });
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    expect(result.aliases).toEqual(expect.arrayContaining(["dex screener", "token research"]));
    expect(result.ecosystems).toEqual(["multichain"]);
    expect(result.exampleIntents).toBeUndefined();
    expect(result.paramKeywords).toEqual(["chainId"]);
  });

  it("mutating tool derives sideEffectLevel: high and operation: execute", () => {
    const manifest = makeManifest({
      toolId: "dexscreener.watchlist.create",
      mutating: true,
      params: [
        { key: "chainId", type: "string", required: true, description: "Chain ID." },
        { key: "tokenAddress", type: "string", required: true, description: "Token address." },
      ],
    });
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    expect(result.sideEffectLevel).toBe("high");
    expect(result.operation).toEqual(["execute"]);
  });

  it("quote tool derives operation: quote", () => {
    const quoteNav: ProtocolNamespaceNavigation = {
      ...MOCK_NAV,
      namespace: "khalani",
      groupId: "cross-chain",
    };
    const manifest = makeManifest({
      toolId: "khalani.quote.get",
      namespace: "khalani",
      mutating: false,
      params: [],
    });
    const result = compileToolDiscoveryMetadata(manifest, quoteNav);

    expect(result.operation).toEqual(["quote"]);
    expect(result.ecosystems).toEqual(expect.arrayContaining(["evm", "solana", "crosschain"]));
  });

  it("override operation replaces inherited value", () => {
    const manifest = makeManifest({
      discovery: { operation: ["monitor"] },
    });
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    expect(result.operation).toEqual(["monitor"]);
  });

  it("deduplicates array values when override repeats inherited entries", () => {
    const manifest = makeManifest({
      discovery: { aliases: ["dex screener", "market scanner"] },
    });
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    const dexScreenerCount = result.aliases!.filter((a) => a === "dex screener").length;
    expect(dexScreenerCount).toBe(1);
    expect(result.aliases).toEqual(expect.arrayContaining(["dex screener", "token research", "market scanner"]));
  });

  it("empty discovery object is treated as no overrides", () => {
    const manifest = makeManifest({ discovery: {} });
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    expect(result.ecosystems).toEqual(["multichain"]);
    expect(result.sourceClass).toBe("specialized_market");
    expect(result.canonicalSummary).toBeUndefined();
  });

  it("embeddingText from discovery passes through compile", () => {
    // Future vector lane reads passages via compileToolDiscoveryMetadata —
    // any consumer using compiled metadata MUST see the per-tool passage.
    // Regression test for a silent merge bug that would have dropped all
    // 61 manifest passages.
    const passage = "Browse token pair analytics. Use this when the user wants to research liquidity and market context. Example queries: show trending tokens, inspect this pair.";
    const manifest = makeManifest({
      discovery: { embeddingText: passage },
    });
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    expect(result.embeddingText).toBe(passage);
  });

  it("chains from discovery passes through compile", () => {
    // Lexical recall on rare chain names (Plasma, Etherlink, Berachain)
    // depends on `chains` reaching `buildSearchFields` after compile.
    const manifest = makeManifest({
      discovery: { chains: ["Ethereum", "Plasma", "Berachain"] },
    });
    const result = compileToolDiscoveryMetadata(manifest, MOCK_NAV);

    expect(result.chains).toEqual(["Ethereum", "Plasma", "Berachain"]);
  });
});
