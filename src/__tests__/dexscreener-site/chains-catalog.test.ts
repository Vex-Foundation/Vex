/**
 * The chains catalog parser and slug resolver, against the real 74-chain
 * catalog captured on 2026-08-24.
 *
 * The resolver is the self-correction seam: the screener answers an unknown
 * chain slug with HTTP 200 and `pairsCount: 0`, which reads to an agent as
 * "nothing trades there". These tests pin that a miss produces the real slug
 * as a candidate, and that the refusal names it.
 */

import { describe, expect, it } from "vitest";
import {
  assertChainSlugsResolved,
  CHAIN_SLUG_MAX_CANDIDATES,
  parseChainsCatalog,
  resolveChainSlugs,
  type CatalogChain,
} from "../../tools/dexscreener/endpoints/chains-catalog.js";
import { DexScreenerSiteErrorCodes } from "../../tools/dexscreener/site-errors.js";
import { VexError } from "../../errors.js";
import { loadJsonFixture } from "./_fixtures.js";

/**
 * Load the catalog capture through the shared fixture loader.
 *
 * The hash-on-every-read policy has ONE owner (`_fixtures.ts`), so a fixture
 * that is edited or re-captured fails loudly here for the same reason and with
 * the same message as every other capture in this directory. This test used to
 * carry its own copy of that check; the copy went when `loadJsonFixture`
 * gained the JSON case a second consumer needed.
 */
function loadCatalogBytes(): Uint8Array {
  return loadJsonFixture("chains-by-trending").bytes;
}

const CHAINS = parseChainsCatalog(loadCatalogBytes());
const CATALOG = {
  chains: CHAINS,
  bySlug: new Map(CHAINS.map((chain) => [chain.slug, chain])),
};

function chain(slug: string): CatalogChain {
  const found = CATALOG.bySlug.get(slug);
  if (found === undefined) throw new Error(`no ${slug} in the capture`);
  return found;
}

describe("parseChainsCatalog", () => {
  it("parses the whole captured catalog", () => {
    expect(CHAINS).toHaveLength(74);
    expect(new Set(CHAINS.map((entry) => entry.slug)).size).toBe(74);
  });

  it("projects a chain's full declared shape", () => {
    const solana = chain("solana");
    expect(solana.name).toBe("Solana");
    expect(solana.architecture).toBe("svm");
    expect(solana.nativeChainId).toBe(1_399_811_149);
    expect(solana.wrappedNativeToken).toBe(
      "So11111111111111111111111111111111111111112"
    );
    expect(solana.dexes).toContain("raydium");
    expect(solana.dexes).toContain("pumpfun");
    expect(solana.dexes.length).toBe(16);
    expect(solana.blockExplorer.accountUrlTemplate).toBe(
      "https://solscan.io/account/{{address}}"
    );
    expect(solana.blockExplorer.holdersUrlTemplate).toBeNull();
    expect(solana.features.metasEnabled).toBe(true);
    expect(solana.integrations["coinGecko"]).toStrictEqual({
      isEnabled: true,
      chainId: "solana",
      networkId: null,
    });
  });

  it("keeps architecture nullable, because 14 of the 74 real chains omit it", () => {
    expect(chain("ton").architecture).toBeNull();
    expect(chain("tron").architecture).toBeNull();
    expect(CHAINS.filter((entry) => entry.architecture === null)).toHaveLength(
      14
    );
    expect(chain("ethereum").architecture).toBe("evm");
  });

  it("keeps integrations optional, because 5 of the 74 real chains omit it", () => {
    expect(
      CHAINS.filter((entry) => Object.keys(entry.integrations).length === 0)
    ).toHaveLength(5);
  });

  /*
   * S8 / I17. The catalog sends integration ids in BOTH wire shapes, and the
   * parser read only strings, so every numeric id projected to null: measured
   * on this same capture, 22 chains carry a numeric `goPlus.networkId` and
   * 10 a numeric `tokenSniffer.networkId`, and all 56 parsed goPlus rows said
   * `networkId: null`. Null there means "the catalog publishes no id", which
   * was false for 22 chains.
   */
  it("normalises an integration id that arrives as a JSON number, which 22 goPlus rows do", () => {
    const raw = JSON.parse(
      new TextDecoder().decode(loadCatalogBytes())
    ) as { slug: string; integrations?: Record<string, { networkId?: unknown }> }[];
    const numericGoPlus = raw.filter(
      (entry) => typeof entry.integrations?.["goPlus"]?.networkId === "number"
    );
    expect(numericGoPlus).toHaveLength(22);

    // Every one of them now carries the id, spelled in base 10.
    for (const entry of numericGoPlus) {
      expect(chain(entry.slug).integrations["goPlus"]?.networkId).toBe(
        String(entry.integrations?.["goPlus"]?.networkId)
      );
    }
    expect(chain("ethereum").integrations["goPlus"]?.networkId).toBe("1");
    expect(chain("bsc").integrations["goPlus"]?.networkId).toBe("56");
    expect(chain("robinhood").integrations["goPlus"]?.networkId).toBe("4663");
    expect(chain("base").integrations["tokenSniffer"]?.networkId).toBe("8453");

    // REVERT-DETECTOR: with the old string-only reader this count was 56.
    const lost = CHAINS.filter(
      (entry) =>
        entry.integrations["goPlus"] !== undefined &&
        entry.integrations["goPlus"].networkId === null
    );
    expect(lost).toHaveLength(34);

    // Still STRICT about what an id may be: a string one is kept verbatim and
    // never coerced, and a non-integer number is not an id at all.
    expect(chain("solana").integrations["coinGecko"]?.chainId).toBe("solana");
    const [oddball] = parseChainsCatalog(
      new TextEncoder().encode(
        JSON.stringify([
          {
            slug: "x",
            name: "X",
            dexes: [],
            blockExplorer: {},
            features: {},
            integrations: {
              a: { isEnabled: true, networkId: 1.5 },
              b: { isEnabled: true, networkId: Number.MAX_SAFE_INTEGER + 2 },
              c: { isEnabled: true, networkId: "" },
            },
          },
        ])
      )
    );
    expect(oddball?.integrations["a"]?.networkId).toBeNull();
    expect(oddball?.integrations["b"]?.networkId).toBeNull();
    expect(oddball?.integrations["c"]?.networkId).toBeNull();
  });

  /*
   * S8 / I17. The explorer-placeholder hazard is not one chain and not one
   * field: the provider's placeholder NAMES do not identify the slots, in
   * every direction. This pins the four measured spellings so a consumer that
   * starts substituting by placeholder name instead of by field goes red.
   */
  it("carries explorer placeholders whose names contradict their slots on several chains and fields", () => {
    // The enumerated case: a token slot spelled {{txns}} on 21 chains.
    const txnsSpelledHolders = CHAINS.filter((entry) =>
      entry.blockExplorer.holdersUrlTemplate?.includes("{{txns}}")
    );
    expect(txnsSpelledHolders).toHaveLength(21);
    // The same token slot spelled {{token}} elsewhere.
    expect(chain("taiko").blockExplorer.holdersUrlTemplate).toContain("{{token}}");
    // A token slot spelled {{address}}.
    expect(chain("beam").blockExplorer.assetUrlTemplate).toContain("{{address}}");
    // And the reverse: a TRANSACTION slot spelled {{address}}.
    expect(chain("oasissapphire").blockExplorer.txnsUrlTemplate).toContain(
      "{{address}}"
    );
    expect(chain("oasissapphire").blockExplorer.txnsUrlTemplate).not.toContain(
      "{{txns}}"
    );
  });

  it("records an integration's declaration without treating it as coverage", () => {
    // 56 chains declare goPlus; only 21 were measured to actually answer.
    // The catalog is the declaration and nothing more.
    const declared = CHAINS.filter(
      (entry) => entry.integrations["goPlus"] !== undefined
    );
    expect(declared.length).toBeGreaterThan(21);
    expect(chain("solana").integrations["goPlus"]?.isEnabled).toBe(false);
  });

  it("tolerates unknown extra fields", () => {
    const parsed = parseChainsCatalog(
      encode([
        {
          slug: "newchain",
          name: "New Chain",
          dexes: [],
          blockExplorer: {},
          features: {},
          somethingDexScreenerAddedLastWeek: { nested: true },
        },
      ])
    );
    expect(parsed[0]?.slug).toBe("newchain");
    expect(parsed[0]?.architecture).toBeNull();
  });

  it("refuses a body that is not JSON, naming the size it got", () => {
    let thrown: unknown;
    try {
      parseChainsCatalog(new TextEncoder().encode("<html>403</html>"));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as VexError).code).toBe(
      DexScreenerSiteErrorCodes.CATALOG_INVALID
    );
    expect((thrown as VexError).message).toContain("16 bytes");
  });

  it("refuses an entry missing a field the surface depends on, by name", () => {
    expect(() =>
      parseChainsCatalog(
        encode([{ slug: "x", name: "X", blockExplorer: {}, features: {} }])
      )
    ).toThrow(/"dexes"/);
    expect(() =>
      parseChainsCatalog(encode([{ name: "X" }]))
    ).toThrow(/"slug"/);
  });
});

describe("resolveChainSlugs", () => {
  it("resolves known slugs to their canonical spelling, in input order", () => {
    expect(
      resolveChainSlugs(CATALOG, ["solana", "BSC", " base "])
    ).toStrictEqual({
      valid: ["solana", "bsc", "base"],
      unknown: [],
    });
  });

  it("deduplicates repeated slugs without losing order", () => {
    expect(resolveChainSlugs(CATALOG, ["base", "solana", "base"]).valid).toStrictEqual([
      "base",
      "solana",
    ]);
  });

  it("offers the real slug as the first candidate for a near miss", () => {
    const resolved = resolveChainSlugs(CATALOG, ["solanna"]);
    expect(resolved.valid).toStrictEqual([]);
    expect(resolved.unknown[0]?.value).toBe("solanna");
    expect(resolved.unknown[0]?.candidates[0]).toBe("solana");
  });

  it("offers a candidate for a truncated guess", () => {
    expect(resolveChainSlugs(CATALOG, ["ether"]).unknown[0]?.candidates).toContain(
      "ethereum"
    );
  });

  it("bounds the candidate list and reports how many were near enough", () => {
    const resolved = resolveChainSlugs(CATALOG, ["a"]);
    const entry = resolved.unknown[0];
    expect(entry?.candidates.length).toBeLessThanOrEqual(
      CHAIN_SLUG_MAX_CANDIDATES
    );
    expect(entry?.candidateCount).toBeGreaterThanOrEqual(
      entry?.candidates.length ?? 0
    );
  });

  it("offers nothing rather than a wrong suggestion when nothing is near", () => {
    const entry = resolveChainSlugs(CATALOG, [
      "definitelynotachainanywhere",
    ]).unknown[0];
    expect(entry?.candidates).toStrictEqual([]);
    expect(entry?.candidateCount).toBe(0);
  });

  it("keeps the caller's spelling verbatim in the report", () => {
    expect(resolveChainSlugs(CATALOG, ["SoLaNNa"]).unknown[0]?.value).toBe(
      "SoLaNNa"
    );
  });
});

describe("assertChainSlugsResolved", () => {
  it("passes a fully resolved list", () => {
    expect(() =>
      assertChainSlugsResolved(resolveChainSlugs(CATALOG, ["solana"]))
    ).not.toThrow();
  });

  it("refuses an unknown slug by name, with the nearest real one, and says why", () => {
    let thrown: unknown;
    try {
      assertChainSlugsResolved(resolveChainSlugs(CATALOG, ["solanna"]));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as VexError).code).toBe(
      DexScreenerSiteErrorCodes.CHAIN_SLUG_UNKNOWN
    );
    expect((thrown as VexError).message).toContain("solanna");
    expect((thrown as VexError).message).toContain("solana");
    expect((thrown as VexError).hint).toContain("zero rows");
  });

  it("names every unknown slug, not only the first", () => {
    let thrown: unknown;
    try {
      assertChainSlugsResolved(
        resolveChainSlugs(CATALOG, ["solanna", "etherium"])
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as VexError).message).toContain("solanna");
    expect((thrown as VexError).message).toContain("etherium");
  });
});

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
