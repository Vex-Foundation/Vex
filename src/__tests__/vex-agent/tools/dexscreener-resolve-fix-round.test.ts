/**
 * The LENS B fix round: resolve and market-context defects Codex's final review
 * found by driving all 18 tools live (plan `tool-plan-v1.md` section 14.6).
 *
 * Every test here is a REGRESSION over a defect that was live, not a
 * restatement of a contract the older suite already proves. In order of what
 * the defect cost:
 *
 *  - B1 A DESCRIPTION THE HANDLER REFUSED. `pair_get` documented `fields:
 *    reactions, insight` and required `include`; a live caller followed the
 *    text and received SCREEN_FIELD_GROUP_UNKNOWN. The regression drives the
 *    EXACT invocation the corrected description tells the model to write.
 *  - B4 A MISSING METRIC READ AS A ZERO. The batch filter compared
 *    `row.liquidityUsd ?? 0`, so a pair the provider reported no metric for was
 *    classified "below your floor" - a data gap presented as a measurement, on
 *    a surface whose rows route money.
 *  - B2 A CONSTRAINT THAT EXISTED ONLY IN PROSE. `pair_get` and the batch tool
 *    described "give one of these" in a sentence nothing enforced.
 *  - B5 CAPS VEX INVENTED. A sixth chain, an eleventh top token and a sixth
 *    enriched narrative were refused by constants with nothing behind them.
 *  - B6 TEXT THAT DISAGREED WITH BEHAVIOR: a truncation key the envelope spec
 *    does not define, and feed sizes stated as fixed when they are bounds.
 */

import { afterEach, describe, expect, it } from "vitest";

import { DEXSCREENER_HANDLERS } from "../../../vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "../../../vex-agent/tools/protocols/dexscreener/manifest.js";
import { validateProtocolParams } from "../../../vex-agent/tools/protocols/runtime/params.js";
import type {
  ProtocolHandler,
  ProtocolToolManifest,
} from "../../../vex-agent/tools/protocols/types.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "../../../tools/dexscreener/transport.js";
import { CLIENT_THRESHOLD_KEYS } from "../../../vex-agent/tools/protocols/dexscreener/manifests/resolve-params.js";
import { SCREEN_THRESHOLD_PARAMS } from "../../../vex-agent/tools/protocols/dexscreener/manifests/screen-params/thresholds.js";
import { loadFixture } from "../../dexscreener-site/_fixtures.js";
import { makeProtocolContext } from "./_test-context.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CTX = makeProtocolContext();

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dexscreener-site",
  "fixtures"
);

const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const REACTIONS_BODY = loadFixture("reactions-ethereum-pepe").bytes;
const INSIGHT_FRAME = loadFixture("token-insight-not-found").bytes;
const SPOTLIGHT_BODY = loadFixture("spotlight-v10").bytes;
const SEARCH_BODY = loadFixture("search-cat-plain").bytes;
const BATCH_FRAME = loadFixture("v8-batch-invalid-and-duplicate.frame").bytes;
const METAS_BODY = loadFixture("metas-trending").bytes;
const SCREENER_FRAME = loadFixture("screener-pairs-solana-trending-h24").bytes;
const CATALOG_BYTES = new Uint8Array(
  readFileSync(path.join(FIXTURE_DIR, "chains-by-trending.json"))
);

/** Every WebSocket and HTTP exchange one call made, in order. */
interface Recorded {
  readonly wsUrls: string[];
  readonly httpUrls: string[];
}

/**
 * A URL-routing transport. Positional scripting cannot express these calls:
 * one `pair_get` with both side reads is a catalog read, a channel exchange, a
 * reactions read and a second channel exchange, and the point of several tests
 * below is exactly WHICH of those were issued.
 */
function fakeTransport(routes: {
  readonly ws?: readonly Uint8Array[];
  readonly search?: Uint8Array;
  readonly spotlight?: Uint8Array;
  readonly metas?: Uint8Array;
  readonly reactions?: { status: number; body: Uint8Array };
}): { readonly transport: DexScreenerTransport; readonly recorded: Recorded } {
  const recorded: Recorded = { wsUrls: [], httpUrls: [] };
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      recorded.httpUrls.push(url);
      const reply = (status: number, body: Uint8Array) =>
        Promise.resolve({ url, status, headers: new Map<string, string>(), body });
      if (url.includes("/ds-data/v2/chains/")) return reply(200, CATALOG_BYTES);
      if (url.includes("/dex/search/spotlight/")) {
        return reply(200, routes.spotlight ?? new Uint8Array());
      }
      if (url.includes("/dex/search/v12/pairs")) {
        return reply(200, routes.search ?? new Uint8Array());
      }
      if (url.includes("/metas/")) return reply(200, routes.metas ?? new Uint8Array());
      if (url.includes("/hype/reactions/")) {
        const r = routes.reactions ?? { status: 404, body: new Uint8Array() };
        return reply(r.status, r.body);
      }
      return Promise.reject(new Error(`unrouted HTTP url: ${url}`));
    },
    wsExchange: (url) => {
      recorded.wsUrls.push(url);
      // Routed most-specific first: the batch channel, the pair channel and
      // the screener pages all live under /dex/screener/.
      if (url.includes("/feed/ws")) return Promise.resolve([INSIGHT_FRAME]);
      if (url.includes("/screener/v7/pairs/")) {
        return Promise.resolve([SCREENER_FRAME]);
      }
      return Promise.resolve([...(routes.ws ?? [])]);
    },
  };
  return { transport, recorded };
}

let release: (() => void) | null = null;

function mount(routes: Parameters<typeof fakeTransport>[0]): Recorded {
  // Re-mounting inside one test is normal here: several regressions compare a
  // default call with an explicit one, and the registry refuses a second
  // transport rather than replacing it.
  release?.();
  release = null;
  const { transport, recorded } = fakeTransport(routes);
  release = registerDexScreenerTransport(transport);
  return recorded;
}

afterEach(() => {
  release?.();
  release = null;
});

function handlerFor(toolId: string): ProtocolHandler {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  return handler;
}

async function call(
  toolId: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await handlerFor(toolId)(params, CTX);
  if (result.success === false) {
    throw new Error(`${toolId} failed: ${result.output}`);
  }
  return JSON.parse(result.output) as Record<string, unknown>;
}

async function callRaw(toolId: string, params: Record<string, unknown>) {
  return handlerFor(toolId)(params, CTX);
}

function manifestFor(toolId: string): ProtocolToolManifest {
  const manifest = DEXSCREENER_TOOLS.find((one) => one.toolId === toolId);
  if (manifest === undefined) throw new Error(`no manifest for ${toolId}`);
  return manifest;
}

function paramKeys(toolId: string): readonly string[] {
  return manifestFor(toolId).params.map((param) => param.key);
}

/* ------------------------------------------------------------------ */
/* B1: one selection key, and it is the one the description names      */
/* ------------------------------------------------------------------ */

describe("B1 pair_get selection key", () => {
  it("answers the exact invocation the description tells the model to write: include=reactions,insight", async () => {
    const recorded = mount({
      ws: [PAIR_FRAME],
      reactions: { status: 200, body: REACTIONS_BODY },
    });
    const out = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      include: "reactions,insight",
    });

    // The snapshot answered.
    expect(out["pair"]).toBeDefined();
    // Both side reads were actually ISSUED, not silently ignored: an `include`
    // key that parsed but did nothing would pass a shallow assertion.
    expect(out["reactions"]).not.toBeNull();
    expect(recorded.httpUrls.some((url) => url.includes("/hype/reactions/"))).toBe(
      true
    );
    expect(recorded.wsUrls.filter((url) => url.includes("/feed/ws"))).toHaveLength(
      1
    );
    // The provider has written nothing about this token: an absence with its
    // own reason, never an error.
    const insight = out["insight"] as Record<string, unknown>;
    expect(insight["available"]).toBe(false);
  });

  it("accepts the same invocation as an array, the other spelling the schema advertises", async () => {
    mount({ ws: [PAIR_FRAME], reactions: { status: 200, body: REACTIONS_BODY } });
    const out = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      include: ["reactions"],
    });
    expect(out["reactions"]).not.toBeNull();
  });

  it("declares both `fields` and `include` as separate selection keys", () => {
    expect(paramKeys("dexscreener.pair.get")).toContain("include");
    expect(paramKeys("dexscreener.pair.get")).toContain("fields");
  });

  it("refuses a side read named inside `fields`, naming the key it belongs in", async () => {
    mount({ ws: [PAIR_FRAME] });
    const result = await callRaw("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      fields: "reactions",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("reactions");
    expect(result.output).toContain("include");
  });

  it("refuses an unknown name inside `include`, naming the accepted side reads", async () => {
    mount({ ws: [PAIR_FRAME] });
    const result = await callRaw("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      include: "nonsense",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("nonsense");
    expect(result.output).toContain("insight");
  });

  it("ships profile links only under fields=profile, and the description says so", async () => {
    mount({ ws: [PAIR_FRAME] });
    const plain = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
    });
    expect((plain["pair"] as Record<string, unknown>)["profile"]).toBeUndefined();

    mount({ ws: [PAIR_FRAME] });
    const asked = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      fields: "profile",
    });
    expect(
      Object.hasOwn(asked["pair"] as Record<string, unknown>, "profile")
    ).toBe(true);

    expect(manifestFor("dexscreener.pair.get").description).toContain(
      "not in the default projection"
    );
  });

  it("refuses an unknown row field group by name, with the field-group vocabulary", async () => {
    mount({ ws: [PAIR_FRAME] });
    const result = await callRaw("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      fields: "nonsense",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("nonsense");
  });
});

/* ------------------------------------------------------------------ */
/* B2: the constraint is schema, not prose                             */
/* ------------------------------------------------------------------ */

describe("B2 atLeastOneOf is declared and enforced", () => {
  it("pair_get declares pairAddress/tokenAddress and the runtime refuses the empty call", () => {
    const manifest = manifestFor("dexscreener.pair.get");
    expect(manifest.atLeastOneOf).toEqual([["pairAddress", "tokenAddress"]]);
    const outcome = validateProtocolParams(manifest, { chain: "ethereum" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("pairAddress");
    expect(outcome.reason).toContain("tokenAddress");
  });

  it("pairs_batch_get declares pairs/tokens and the runtime refuses the empty call", () => {
    const manifest = manifestFor("dexscreener.pairs.batch");
    expect(manifest.atLeastOneOf).toEqual([["pairs", "tokens"]]);
    const outcome = validateProtocolParams(manifest, { window: "h24" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("pairs");
    expect(outcome.reason).toContain("tokens");
  });

  it("accepts either member, and both together", () => {
    const manifest = manifestFor("dexscreener.pairs.batch");
    expect(validateProtocolParams(manifest, { pairs: "ethereum:0xA" }).ok).toBe(true);
    expect(validateProtocolParams(manifest, { tokens: "ethereum:0xB" }).ok).toBe(true);
    expect(
      validateProtocolParams(manifest, {
        pairs: "ethereum:0xA",
        tokens: "ethereum:0xB",
      }).ok
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* B3: the full client-side threshold family, and the spotlight axis   */
/* ------------------------------------------------------------------ */

describe("B3 threshold family and spotlight fields", () => {
  const declared = SCREEN_THRESHOLD_PARAMS.map((param) => param.key);

  it("every key the evaluator answers for is a real S2b threshold, reused not re-declared", () => {
    for (const key of CLIENT_THRESHOLD_KEYS) {
      expect(declared).toContain(key);
    }
  });

  for (const toolId of ["dexscreener.pairs.batch", "dexscreener.tokenPairs"]) {
    it(`${toolId} advertises the whole family`, () => {
      const keys = paramKeys(toolId);
      for (const key of CLIENT_THRESHOLD_KEYS) expect(keys).toContain(key);
    });
  }

  it("batch applies a CEILING threshold, which it could not express before", async () => {
    mount({ ws: [BATCH_FRAME] });
    const out = await call("dexscreener.pairs.batch", {
      pairs: "ethereum:0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      maxLiquidityUsd: 1,
    });
    const filtering = out["clientFiltering"] as Record<string, unknown>;
    expect(filtering["returned"]).toBe(0);
    expect(
      (filtering["droppedByFilter"] as Record<string, number>)["maxLiquidityUsd"]
    ).toBe(1);
    expect(
      (out["filtersApplied"] as Record<string, number>)["maxLiquidityUsd"]
    ).toBe(1);
  });

  it("token_pairs_list applies a threshold the four-key set never had", async () => {
    mount({ search: SEARCH_BODY });
    const out = await call("dexscreener.tokenPairs", {
      chain: "solana",
      tokenAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      minFdvUsd: 1e18,
    });
    expect(
      (out["filtersApplied"] as Record<string, number>)["minFdvUsd"]
    ).toBe(1e18);
  });

  it("spotlight keeps issuer prose out of the default projection and ships it on request", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const plain = await call("dexscreener.spotlight", { feed: "latestProfiles" });
    const plainRow = (plain["latestProfiles"] as Record<string, unknown>[])[0];
    expect(plainRow).toBeDefined();
    expect(Object.hasOwn(plainRow ?? {}, "description")).toBe(false);
    expect(Object.hasOwn(plainRow ?? {}, "links")).toBe(false);

    mount({ spotlight: SPOTLIGHT_BODY });
    const rich = await call("dexscreener.spotlight", {
      feed: "latestProfiles",
      fields: "description,links",
    });
    const richRow = (rich["latestProfiles"] as Record<string, unknown>[])[0];
    expect(Object.hasOwn(richRow ?? {}, "description")).toBe(true);
    expect(Object.hasOwn(richRow ?? {}, "links")).toBe(true);
    expect(rich["externalContentFields"]).toContain("latestProfiles[].links[].url");
  });

  it("refuses an unknown spotlight group instead of silently shipping the default", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const result = await callRaw("dexscreener.spotlight", { fields: "allWindows" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("allWindows");
  });
});

/* ------------------------------------------------------------------ */
/* B4: missing is not zero                                             */
/* ------------------------------------------------------------------ */

describe("B4 a row without the metric is not_evaluated, never below_min", () => {
  const KNOWN = "ethereum:0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";

  it("keeps a row whose metric the provider never reported and counts it in notEvaluated", async () => {
    mount({ ws: [BATCH_FRAME] });
    // The captured pair is a plain Uniswap pool: it is not on a bonding curve,
    // so the provider reports no launchpad progress for it at all. Under the
    // old `?? 0` the comparison would have read 0 and dropped it as "below
    // your floor", which is a data gap dressed as a measurement.
    const out = await call("dexscreener.pairs.batch", {
      pairs: KNOWN,
      minLaunchpadProgressPct: 50,
    });
    const filtering = out["clientFiltering"] as Record<string, unknown>;

    expect(filtering["returned"]).toBe(1);
    expect(filtering["dropped"]).toBe(0);
    expect(filtering["droppedByFilter"]).toEqual({});
    expect(
      (filtering["notEvaluated"] as Record<string, number>)[
        "minLaunchpadProgressPct"
      ]
    ).toBe(1);
    // The envelope must SAY it, not merely carry a count nobody reads.
    expect(String(filtering["note"])).toContain("not a measurement of zero");
  });

  it("still drops a row whose metric IS reported and is below the floor", async () => {
    mount({ ws: [BATCH_FRAME] });
    const out = await call("dexscreener.pairs.batch", {
      pairs: KNOWN,
      minLiquidityUsd: 1e15,
    });
    const filtering = out["clientFiltering"] as Record<string, unknown>;
    expect(filtering["returned"]).toBe(0);
    expect(
      (filtering["droppedByFilter"] as Record<string, number>)["minLiquidityUsd"]
    ).toBe(1);
    expect(filtering["notEvaluated"]).toEqual({});
  });

  it("accounts for every provider row on both paths: kept plus dropped equals received", async () => {
    for (const params of [
      { minLaunchpadProgressPct: 50 },
      { minLiquidityUsd: 1e15 },
      { minBoostCount: 3, maxVolumeUsd: 1 },
    ]) {
      mount({ ws: [BATCH_FRAME] });
      const out = await call("dexscreener.pairs.batch", { pairs: KNOWN, ...params });
      const filtering = out["clientFiltering"] as Record<string, number>;
      expect(filtering["returned"] + filtering["dropped"]).toBe(
        filtering["providerReturned"]
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* B5: the invented caps are gone                                      */
/* ------------------------------------------------------------------ */

describe("B5 caps that bounded nothing real", () => {
  it("search fans out past the old hard five when maxChains says so", async () => {
    const recorded = mount({ search: SEARCH_BODY });
    const out = await call("dexscreener.search", {
      query: "CAT",
      chainIds: "solana,base,ethereum,bsc,polygon,arbitrum",
      maxChains: 6,
    });
    const searches = recorded.httpUrls.filter((url) =>
      url.includes("/dex/search/v12/pairs")
    );
    expect(searches).toHaveLength(6);
    expect((out["providerWindow"] as Record<string, unknown>)["maxChains"]).toBe(6);
    expect(out["chainsQueried"]).toHaveLength(6);
  });

  it("refuses a fan-out past the DEFAULT by naming the parameter that raises it", async () => {
    mount({ search: SEARCH_BODY });
    const result = await callRaw("dexscreener.search", {
      query: "CAT",
      chainIds: "solana,base,ethereum,bsc,polygon,arbitrum",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("maxChains");
    expect(result.output).toContain("no upper bound");
  });

  /**
   * S9-2. The narratives handler resolved its `chain` with a bare
   * `bySlug.get`, a second lookup beside the catalog's own resolver, and so it
   * broke both of that resolver's promises: a typo came back with no
   * candidates, and a numeric chain id was refused even though the catalog
   * carries `nativeChainId` and this surface's chain sentence offers that
   * spelling.
   */
  it("a mistyped narrative chain is refused WITH candidates, like every other chain param", async () => {
    mount({ metas: METAS_BODY });
    const result = await callRaw("dexscreener.trending", { chain: "solna" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("solna");
    expect(result.output).toContain("did you mean");
    expect(result.output).toContain("solana");
  });

  it("a numeric chain id resolves to its slug rather than being refused", async () => {
    const recorded = mount({ metas: METAS_BODY });
    await callRaw("dexscreener.trending", { chain: "8453", limit: 1 });
    // The chain reached the PROVIDER as the catalog's slug. Before the fix the
    // call was refused as an unknown chain and no narratives request existed.
    const narratives = recorded.httpUrls.filter((url) => url.includes("/metas/"));
    expect(narratives.some((url) => url.includes("chainId=base"))).toBe(true);
    expect(narratives.some((url) => url.includes("8453"))).toBe(false);
  });

  it("narratives accept a topTokens above the old ceiling of ten", async () => {
    mount({ metas: METAS_BODY });
    const out = await call("dexscreener.trending", { topTokens: 25, limit: 1 });
    expect(
      (out["topTokensCoverage"] as Record<string, unknown>)["perNarrative"]
    ).toBe(25);
  });

  it("narratives enrich past the old hard five when maxEnrichedNarratives says so", async () => {
    mount({ metas: METAS_BODY });
    const out = await call("dexscreener.trending", {
      topTokens: 1,
      limit: 8,
      maxEnrichedNarratives: 8,
    });
    const coverage = out["topTokensCoverage"] as Record<string, unknown>;
    expect(coverage["maxEnrichedNarratives"]).toBe(8);
    expect((coverage["enrichedNarrativeIds"] as string[]).length).toBe(8);
    expect(coverage["notEnrichedNarrativeIds"]).toEqual([]);
    expect(coverage["requestsIssued"]).toBe(8);
  });

  it("still defaults to five enriched narratives and names the rest", async () => {
    mount({ metas: METAS_BODY });
    const out = await call("dexscreener.trending", { topTokens: 1, limit: 8 });
    const coverage = out["topTokensCoverage"] as Record<string, unknown>;
    expect((coverage["enrichedNarrativeIds"] as string[]).length).toBe(5);
    expect((coverage["notEnrichedNarrativeIds"] as string[]).length).toBe(3);
  });

  it("names the WebSocket cost of raising the enrichment bound", () => {
    const manifest = manifestFor("dexscreener.trending");
    const param = manifest.params.find(
      (one) => one.key === "maxEnrichedNarratives"
    );
    expect(param?.description).toContain("WebSocket");
    const topTokens = manifest.params.find((one) => one.key === "topTokens");
    expect(topTokens?.description).toContain("WebSocket");
  });
});

/* ------------------------------------------------------------------ */
/* B6: text and behavior say the same thing                            */
/* ------------------------------------------------------------------ */

describe("B6 envelope key and honest bounds", () => {
  it("search emits the spec's `truncated`, not the `truncatedByLimit` drift", async () => {
    mount({ search: SEARCH_BODY });
    const out = await call("dexscreener.search", { query: "CAT", limit: 2 });
    expect(Object.hasOwn(out, "truncatedByLimit")).toBe(false);
    expect(out["truncated"]).toBe(true);
    expect(String(out["truncationNote"])).toContain("Raise limit");
  });

  it("token_pairs_list emits the same key, false when nothing was held back", async () => {
    mount({ search: SEARCH_BODY });
    const out = await call("dexscreener.tokenPairs", {
      chain: "solana",
      tokenAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      limit: 1000,
    });
    expect(Object.hasOwn(out, "truncatedByLimit")).toBe(false);
    expect(out["truncated"]).toBe(false);
  });

  it("spotlight states its feed sizes as bounds and reports what each feed actually held", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const out = await call("dexscreener.spotlight", {});
    const window = out["providerWindow"] as Record<string, unknown>;
    expect(String(window["note"])).toContain("bound and not a promise");
    expect(Object.keys(window["feedSizes"] as object).sort()).toEqual([
      "latestProfiles",
      "recentBoosts",
      "topBoosts",
    ]);
    expect(manifestFor("dexscreener.spotlight").description).toContain(
      "Row counts are provider bounds, not promises"
    );
  });

  it("the batch tool no longer claims an input ceiling of a hundred", () => {
    const manifest = manifestFor("dexscreener.pairs.batch");
    const text = [
      manifest.description,
      manifest.discovery?.canonicalSummary ?? "",
      ...manifest.params.map((param) => param.description),
    ].join(" ");
    expect(text).not.toContain("up to 100");
    expect(manifest.description).toContain("no artificial input ceiling");
  });

  /*
   * CONTRACT CHANGE (S8 / I10). The source doc's narratives block no longer
   * says narratives exist on four chains only, because that was measured
   * false: the endpoint serves real aggregates on robinhood, ton and polygon,
   * whose catalog `features.metas.isEnabled` is false. The four chains are a
   * site-visibility label. This test now pins the corrected sentences and the
   * ABSENCE of the old claim, so a revert to the four-chain gate goes red in
   * the model-visible description as well as in the handler.
   */
  it("the narratives description matches the coordinator's corrected source sentences", () => {
    const description = manifestFor("dexscreener.trending").description;
    expect(description).toContain("List the 18 DexScreener narratives");
    expect(description).toContain(
      "Aggregates exist for any chain with narrative activity"
    );
    expect(description).toContain("a visibility label, never a data gate");
    expect(description).not.toContain(
      "narratives exist on solana, bsc, base, and ethereum only"
    );
    expect(description).not.toContain("refused by name");
  });
});

/* ------------------------------------------------------------------ */
/* FI7a: `fields` shapes rows, it must never move the routing math     */
/* ------------------------------------------------------------------ */

describe("FI7a token_pairs matching arithmetic is independent of `fields`", () => {
  // bsc:0x6894...3063D is the one base token this fixture repeats across
  // several rows, so the window contains both matching and unrelated rows -
  // the case where reading the shaped row (which only emits
  // `quoteTokenAddress` under `fields: "identity"`) could silently drop
  // pools from the match and move every denominator.
  const CHAIN = "bsc";
  const TOKEN = "0x6894CDe390a3f51155ea41Ed24a33A4827d3063D";

  it("matchedInWindow, totalLiquidityUsd and every row's shares are identical with and without fields=identity", async () => {
    mount({ search: SEARCH_BODY });
    const plain = await call("dexscreener.tokenPairs", {
      chain: CHAIN,
      tokenAddress: TOKEN,
    });

    mount({ search: SEARCH_BODY });
    const withIdentity = await call("dexscreener.tokenPairs", {
      chain: CHAIN,
      tokenAddress: TOKEN,
      fields: "identity",
    });

    // Sanity: the token actually has more than one matching pool in this
    // fixture, and the assertion below would be vacuous otherwise.
    expect(plain["matchedInWindow"]).toBeGreaterThan(1);

    expect(withIdentity["matchedInWindow"]).toBe(plain["matchedInWindow"]);
    expect(withIdentity["totalLiquidityUsd"]).toBe(plain["totalLiquidityUsd"]);
    expect(withIdentity["totalVolumeUsd"]).toBe(plain["totalVolumeUsd"]);

    const byPair = (rows: unknown): Map<string, Record<string, unknown>> =>
      new Map(
        (rows as Record<string, unknown>[]).map((row) => [
          String(row["pairAddress"]),
          row,
        ])
      );
    const plainRows = byPair(plain["rows"]);
    const identityRows = byPair(withIdentity["rows"]);
    expect(identityRows.size).toBe(plainRows.size);
    for (const [pairAddress, row] of plainRows) {
      const identityRow = identityRows.get(pairAddress);
      expect(identityRow).toBeDefined();
      expect(identityRow?.["liquiditySharePct"]).toBe(row["liquiditySharePct"]);
      expect(identityRow?.["volumeSharePct"]).toBe(row["volumeSharePct"]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* FI7b: providerCapped must not claim a full window on zero matches   */
/* ------------------------------------------------------------------ */

describe("FI7b providerCapped is false, and the no-match outcome fires, when nothing matched", () => {
  it("a 30-row provider window with zero matching rows reports providerCapped false and noRowsMatchedIdentity, not the cap advice", async () => {
    mount({ search: SEARCH_BODY });
    // A well-shaped address that appears nowhere in the fixture: the window
    // is still the provider's full 30-row page (SEARCH_BODY has exactly 30
    // rows), but none of them trade this token.
    const out = await call("dexscreener.tokenPairs", {
      chain: "ethereum",
      tokenAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(out["matchedInWindow"]).toBe(0);
    expect(out["providerCapped"]).toBe(false);
    expect(Object.hasOwn(out, "providerCappedAdvice")).toBe(false);
    const noMatch = out["noRowsMatchedIdentity"] as Record<string, unknown>;
    expect(noMatch).toBeDefined();
    expect(noMatch["providerReturned"]).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* FI5: the launchpad board actually shows launchpad data              */
/* ------------------------------------------------------------------ */

describe("FI5 launchpad board ships progress at default params and refuses the empty combination", () => {
  it("a default-params launchpad call ships the launchpad field group without asking for fields", async () => {
    mount({ ws: [SCREENER_FRAME] });
    const out = await call("dexscreener.launchpad.pairs", {});
    const rows = out["rows"] as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => Object.hasOwn(row, "launchpad"))).toBe(true);
  });

  it("refuses launchpadIds combined with stage=bonding by name, with a dexIds remedy", async () => {
    mount({ ws: [SCREENER_FRAME] });
    const result = await callRaw("dexscreener.launchpad.pairs", {
      launchpadIds: "pumpfun",
      stage: "bonding",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("launchpadIds");
    expect(result.output).toContain("bonding");
    expect(result.output).toContain("dexIds");
  });
});

/* ------------------------------------------------------------------ */
/* FI14: pair_get tells the truth about its window and its ignored arg */
/* ------------------------------------------------------------------ */

describe("FI14 pair_get honesty", () => {
  it("emits windowSize and matchedInWindow as distinct numbers, not one figure standing in for both", async () => {
    mount({ search: SEARCH_BODY, ws: [PAIR_FRAME] });
    const out = await call("dexscreener.pair.get", {
      chain: "bsc",
      tokenAddress: "0x6894CDe390a3f51155ea41Ed24a33A4827d3063D",
    });
    expect(typeof out["resolutionBasis"]).toBe("string");
    const note = String(out["resolutionNote"]);
    // The old copy said "the deepest of the 30 pools" when only some of the
    // window's rows were actually this token's. The corrected note must name
    // both figures, and they must differ on this fixture.
    expect(note).toMatch(/deepest among the \d+ pools/i);
    expect(note).toMatch(/returned \d+ rows in total/i);
    const matched = Number(note.match(/deepest among the (\d+) pools/i)?.[1]);
    const windowSize = Number(note.match(/returned (\d+) rows in total/i)?.[1]);
    expect(Number.isFinite(matched)).toBe(true);
    expect(Number.isFinite(windowSize)).toBe(true);
    expect(matched).not.toBe(windowSize);
  });

  it("emits ignoredParams naming tokenAddress when both pairAddress and tokenAddress are given", async () => {
    mount({ ws: [PAIR_FRAME] });
    const out = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      tokenAddress: "0xCeba75c4D1BCF24452040E98Eb3b2107A2877F36",
    });
    const ignored = out["ignoredParams"] as Record<string, unknown>;
    expect(ignored).toBeDefined();
    expect(ignored["tokenAddress"]).toBe(
      "0xCeba75c4D1BCF24452040E98Eb3b2107A2877F36"
    );
    expect(String(ignored["note"])).toContain(
      "0xCeba75c4D1BCF24452040E98Eb3b2107A2877F36"
    );
  });
});
