/**
 * Discovery golden harness — measures top-3 retrieval quality on realistic
 * English capability-phrase intents. PR1 baseline (18); PR4 extends to 32.
 *
 * Fixtures stay English-only; ToolSearch is evaluated on English
 * capability phrases.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { discoverProtocolCapabilities } from "../../../vex-agent/tools/protocols/runtime.js";

interface GoldenFixture {
  intent: string;
  expectedAny: readonly string[];
  k?: number;
  notes?: string;
}

const FIXTURES: readonly GoldenFixture[] = [
  // ── namespace-specific ────────────────────────────────────────────
  { intent: "bridge usdc to base", expectedAny: ["khalani.bridge", "khalani.quote"] },
  { intent: "cross chain token search", expectedAny: ["khalani.tokens"] },
  { intent: "supported bridge chains", expectedAny: ["khalani.chains"] },
  { intent: "swap on base", expectedAny: ["kyberswap.swap"] },
  { intent: "honeypot token check", expectedAny: ["kyberswap.tokens"] },
  { intent: "swap on solana", expectedAny: ["solana.swap"] },
  { intent: "solana token search", expectedAny: ["solana.tokens"] },
  { intent: "fresh solana tokens", expectedAny: ["solana.tokens.trending"] },
  { intent: "jupiter price lookup", expectedAny: ["solana.prices"] },
  // THREE DEXSCREENER FIXTURES CHANGED IN S3.5, and what happened to each.
  //
  // "trending meme tokens" was pinned to `dexscreener.trending` by a lexical
  // anchor added when the Trench launchpad's `tokens` token displaced it
  // (trench.tokens 99 vs trending 58; after the anchor, trending 129). That
  // anchor lived in the retired `embeddings/dexscreener/trending.ts` and died
  // with it. It is NOT re-added: the query asks for trending TOKENS, and
  // `dexscreener.trending` is now the NARRATIVE aggregate, which is exactly
  // the confusion the rename to `dexscreener__narratives_list` exists to end.
  // The fixture is retired rather than retargeted, because the surviving pair
  // board answers "which pairs", and the token-shaped query is legitimately
  // owned by the solana, trench and pools surfaces that now hold the top 3.
  //
  // "community takeover" is retired with no successor. Plan 4.6 records the
  // CTO feed as a NAMED omission (owner decision D-DS3): the public API's feed
  // has no site equivalent and was dropped rather than kept alive. A fixture
  // pinning an intent nothing answers would be a false guard.
  //
  // "pair liquidity analytics" survives and is retargeted to the tools that
  // now answer it: one pool's live state, and one token's pools ranked by
  // depth.
  { intent: "pair liquidity analytics", expectedAny: ["dexscreener.pair.get", "dexscreener.tokenPairs"] },
  { intent: "which narrative or meta sector is moving", expectedAny: ["dexscreener.trending"] },
  { intent: "who just bought a boost", expectedAny: ["dexscreener.spotlight"] },
  { intent: "new token launches on trench", expectedAny: ["trench.tokens"] },
  { intent: "newest tokens on robinhood", expectedAny: ["trench.tokens"] },
  { intent: "trench bonding curve tokens", expectedAny: ["trench.tokens"] },
  { intent: "preview a token launch cost on trench", expectedAny: ["trench.launch_preview"] },
  { intent: "trench launchpad trade tape", expectedAny: ["trench.trades", "trench.tokens"] },
  // ── ambiguous / cross-namespace ───────────────────────────────────
  { intent: "wallet token balances", expectedAny: ["khalani.tokens", "solana.tokens"] },
  { intent: "prediction market events", expectedAny: ["solana.predict.events"] },
  { intent: "token search", expectedAny: ["khalani.tokens", "solana.tokens", "kyberswap.tokens", "dexscreener.search"] },

  // ── param-driven ──────────────────────────────────────────────────
  { intent: "slippage tolerance swap quote", expectedAny: ["kyberswap.swap", "solana.swap"] },
  { intent: "amount in chain id", expectedAny: ["khalani.quote", "kyberswap.swap"] },
  // Generic token-info query: many tools legitimately match (token resolvers,
  // bridges that take token addresses, swap tools that route by address). Accept
  // broad namespace prefixes — the goal is "some token-handling tool ranks".
  { intent: "token address contract info", expectedAny: ["dexscreener.", "khalani.", "solana.tokens", "kyberswap."] },

  // ── rare-chain lexical recall (validates structured `chains` field) ─
  { intent: "swap on plasma", expectedAny: ["kyberswap.swap"] },
  { intent: "bridge to monad", expectedAny: ["khalani.bridge", "khalani.quote"] },
  // "lp on berachain" retired (Agent Scan plan v3 — KyberSwap zap deleted, the
  // tool this fixture validated chain-field recall against no longer exists;
  // no replacement invented — see the rare-chain recall block below, which
  // dropped the matching kyberswap.zap case for the same reason).
];

describe("discovery golden harness", () => {
  const ENV_KEYS = [
    "JUPITER_API_KEY",
    "POLYMARKET_API_KEY",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIM",
    "EMBEDDING_PROVIDER",
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    process.env.JUPITER_API_KEY = "test-jupiter-key";
    process.env.POLYMARKET_API_KEY = "test-polymarket-key";
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIM;
    delete process.env.EMBEDDING_PROVIDER;
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  for (const fixture of FIXTURES) {
    const k = fixture.k ?? 3;
    it(`top-${k} for "${fixture.intent}" contains expected`, async () => {
      const result = await discoverProtocolCapabilities({
        query: fixture.intent,
        limit: k,
      });
      const topIds = result.tools.map((t) => t.toolId);
      const hit = fixture.expectedAny.some((expected) =>
        topIds.some((id) => id === expected || id.startsWith(`${expected}.`) || id.startsWith(expected)),
      );
      expect(hit, `topIds=${JSON.stringify(topIds)}`).toBe(true);
    });
  }

  // ── Rare-chain recall via structured `chains` field ───────────────
  // After the agent-style refactor, chain enumerations live in the
  // structured `discovery.chains` field (not interpolated into
  // `embeddingText` anymore). The lexical scorer reads them via
  // `buildMetadataFields` at weight 3. These tests assert chain matches
  // ARE driven by the `chains` field — not coincidentally by intent
  // words — by checking `whyMatched.includes("chains")`.

  it.each([
    { intent: "swap on plasma", expectedToolPrefix: "kyberswap.swap", chain: "plasma" },
    { intent: "bridge to monad", expectedToolPrefix: "khalani.bridge", chain: "monad" },
  ])("rare-chain '$chain' — top-5 contains $expectedToolPrefix tagged whyMatched: 'chains'",
    async ({ intent, expectedToolPrefix }) => {
      const result = await discoverProtocolCapabilities({ query: intent, limit: 5 });
      const expected = result.tools.find((t) => t.toolId.startsWith(expectedToolPrefix));
      expect(
        expected,
        `expected toolId starting with '${expectedToolPrefix}' in top-5 for '${intent}'; got ${JSON.stringify(result.tools.map((t) => t.toolId))}`,
      ).toBeDefined();
      expect(
        expected!.whyMatched,
        `'${intent}' matched ${expected!.toolId} but NOT via the structured chains field — whyMatched=${JSON.stringify(expected!.whyMatched)}`,
      ).toContain("chains");
    },
  );

  it("baseline summary: top-3 recall across all fixtures", async () => {
    // Recall is computed only over enabled fixtures so the threshold remains
    // meaningful while disabled-namespace fixtures are skipped above.
    const activeFixtures = FIXTURES.filter((f) => !f.disabled);
    let hits = 0;
    const misses: string[] = [];
    for (const fixture of activeFixtures) {
      const k = fixture.k ?? 3;
      const result = await discoverProtocolCapabilities({
        query: fixture.intent,
        limit: k,
      });
      const topIds = result.tools.map((t) => t.toolId);
      const hit = fixture.expectedAny.some((expected) =>
        topIds.some((id) => id === expected || id.startsWith(`${expected}.`) || id.startsWith(expected)),
      );
      if (hit) hits += 1;
      else misses.push(`${fixture.intent} -> got ${JSON.stringify(topIds)}`);
    }
    const recall = hits / activeFixtures.length;
    // PR4 floor: 70% (raised from 50% after PR1-3 consistently hit 100%).
    expect(
      recall,
      `top-3 recall ${(recall * 100).toFixed(1)}% (${hits}/${activeFixtures.length}). misses:\n${misses.join("\n")}`,
    ).toBeGreaterThanOrEqual(0.7);
  });
});
