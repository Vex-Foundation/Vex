/**
 * The three S3 resolve and market-context handlers, driven by a fake transport
 * over the REAL captured provider bytes.
 *
 * Same reasoning as the screening handler tests: the transport is the process
 * and trust boundary, the bytes it replays are the provider's own (hash-checked
 * by `_fixtures.ts`), and everything above it - the identity parsing, the
 * projection, the field groups, the accounting and the summary sentence - runs
 * for real.
 *
 * What these tests exist to catch, in order of what the defect would cost:
 *
 *  - AN INPUT THAT DISAPPEARS. The v8 channel drops identities it cannot
 *    resolve without saying so. A watchlist refresh that loses a pair silently
 *    is the worst failure this surface can have, so the accounting is asserted
 *    to sum to what was passed, on every path.
 *  - A TOKEN RESOLUTION PRESENTED AS A GLOBAL CLAIM. "Deepest pool" is only
 *    ever deepest among at most 30 the provider chose to send; the basis and
 *    the note must travel with the answer.
 *  - AN OPTIONAL SIDE READ TAKING THE WHOLE CALL DOWN. Reactions and insight
 *    are decoration; a provider that has neither must still produce a snapshot.
 *  - ISSUER TEXT REACHING THE MODEL UNLABELLED. Every response carrying
 *    issuer-authored or provider-generated prose must name it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEXSCREENER_HANDLERS } from "../../../vex-agent/tools/protocols/dexscreener/handlers.js";
import type { ProtocolHandler } from "../../../vex-agent/tools/protocols/types.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "../../../tools/dexscreener/transport.js";
import { parseBatchInputs } from "../../../vex-agent/tools/protocols/dexscreener/handlers/resolve.js";
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
const SPOTLIGHT_BODY = loadFixture("spotlight-v10").bytes;
const SEARCH_BODY = loadFixture("search-cat-plain").bytes;
const BATCH_FRAME = loadFixture("v8-batch-invalid-and-duplicate.frame").bytes;
const CATALOG_BYTES = new Uint8Array(
  readFileSync(path.join(FIXTURE_DIR, "chains-by-trending.json"))
);

interface Recorded {
  readonly wsUrls: string[];
  readonly httpUrls: string[];
}

/**
 * A transport that routes by URL, because these tools mix HTTP and WebSocket
 * against several endpoints in one call and a positional script could not
 * express "the catalog, then a search, then a channel".
 */
function fakeTransport(routes: {
  readonly ws?: readonly Uint8Array[];
  readonly search?: Uint8Array;
  readonly spotlight?: Uint8Array;
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
      if (url.includes("/hype/reactions/")) {
        const r = routes.reactions ?? { status: 404, body: new Uint8Array() };
        return reply(r.status, r.body);
      }
      return Promise.reject(new Error(`unrouted HTTP url: ${url}`));
    },
    wsExchange: (url) => {
      recorded.wsUrls.push(url);
      return Promise.resolve([...(routes.ws ?? [])]);
    },
  };
  return { transport, recorded };
}

let release: (() => void) | null = null;

function mount(routes: Parameters<typeof fakeTransport>[0]): Recorded {
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
  return JSON.parse(result.output) as Record<string, unknown>;
}

async function callRaw(toolId: string, params: Record<string, unknown>) {
  return handlerFor(toolId)(params, CTX);
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

describe("the three S3 tools are wired", () => {
  for (const toolId of [
    "dexscreener.pair.get",
    "dexscreener.spotlight",
    "dexscreener.pairs.batch",
  ]) {
    it(`${toolId} has a handler`, () => {
      expect(typeof DEXSCREENER_HANDLERS[toolId]).toBe("function");
    });
  }
});

/* ------------------------------------------------------------------ */
/* Tool 9: pair_get                                                    */
/* ------------------------------------------------------------------ */

describe("dexscreener.pair.get", () => {
  it("returns the windowed row for an explicit pair address and says how it resolved", async () => {
    mount({ ws: [PAIR_FRAME] });
    const out = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
    });
    expect(out["resolutionBasis"]).toBe("explicit_pair_address");
    expect(out["window"]).toBe("h24");
    const pair = out["pair"] as Record<string, unknown>;
    expect(pair["baseTokenSymbol"]).toBe("PEPE");
    expect(pair["chainId"]).toBe("ethereum");
    // The fields the public API never carried are the point of this surface.
    expect(pair["buyers"]).not.toBeNull();
    expect(pair["makers"]).not.toBeNull();
    // No side read was asked for, so neither is present as data.
    expect(out["reactions"]).toBeNull();
    expect(out["insight"]).toBeNull();
  });

  it("reports every window when the allWindows group is asked for", async () => {
    mount({ ws: [PAIR_FRAME] });
    const out = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      fields: "allWindows",
      window: "h1",
    });
    const pair = out["pair"] as Record<string, unknown>;
    const windows = pair["windows"] as Record<string, unknown>;
    expect(Object.keys(windows).sort()).toEqual(["h1", "h24", "h6", "m5"]);
  });

  it("resolves a token address to the deepest pool of the bounded window and refuses to call it global", async () => {
    mount({ ws: [PAIR_FRAME], search: SEARCH_BODY });
    // The captured search window is a CAT query; its rows carry their own base
    // token, so resolution is asserted against a token that is really in it.
    const searchRows = JSON.parse(
      JSON.stringify(
        await (async () => {
          const { parseSearchResponse } = await import(
            "../../../tools/dexscreener/endpoints/search.js"
          );
          return parseSearchResponse(SEARCH_BODY);
        })()
      )
    ) as { chainId: string; baseToken: { address: string } }[];
    const target = searchRows[0];
    expect(target).toBeDefined();

    const out = await call("dexscreener.pair.get", {
      chain: target?.chainId,
      tokenAddress: target?.baseToken.address,
    });
    expect(out["resolutionBasis"]).toBe("deepest_of_search_window");
    expect(out["resolvedFrom"]).toBe(target?.baseToken.address);
    expect(String(out["resolutionNote"])).toContain("not a claim about every pool");
  });

  it("refuses when neither a pair nor a token address was given", async () => {
    mount({ ws: [PAIR_FRAME] });
    const result = await callRaw("dexscreener.pair.get", { chain: "ethereum" });
    expect(result.output).toContain("Neither pairAddress nor tokenAddress");
  });

  it("refuses an unknown chain by name instead of reporting the pair missing", async () => {
    mount({ ws: [PAIR_FRAME] });
    const result = await callRaw("dexscreener.pair.get", {
      chain: "solanaa",
      pairAddress: "0xabc",
    });
    expect(result.output).toContain("solanaa");
  });

  it("attaches reactions when asked, labelled as clicks rather than demand", async () => {
    mount({
      ws: [PAIR_FRAME],
      reactions: { status: 200, body: REACTIONS_BODY },
    });
    const out = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      include: "reactions",
    });
    const reactions = out["reactions"] as Record<string, unknown>;
    expect((reactions["totals"] as Record<string, number>)["rocket"]).toBe(11045);
    expect(String(reactions["note"])).toContain("not demand");
  });

  it("keeps the snapshot when an optional side read is unavailable", async () => {
    mount({ ws: [PAIR_FRAME], reactions: { status: 503, body: new Uint8Array() } });
    const out = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
      include: "reactions",
    });
    expect(out["pair"]).toBeDefined();
    expect(out["reactions"]).toBeNull();
    expect(String(out["reactionsUnavailable"])).toContain("unaffected");
  });

  it("names issuer-authored fields as untrusted on every answer", async () => {
    mount({ ws: [PAIR_FRAME] });
    const out = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xA43fe1",
    });
    expect(out["externalContentFields"]).toContain("baseTokenSymbol");
    expect(String(out["externalContentWarning"])).toContain("untrusted");
    expect(Array.isArray(out["sanitizedFields"])).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Tool 15: spotlight_get                                              */
/* ------------------------------------------------------------------ */

describe("dexscreener.spotlight", () => {
  it("returns all three feeds by default and says a boost is bought visibility", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const out = await call("dexscreener.spotlight", {});
    expect(out["feed"]).toBe("all");
    expect(out["topBoosts"]).toBeDefined();
    expect(out["recentBoosts"]).toBeDefined();
    expect(out["latestProfiles"]).toBeDefined();
    expect(String(out["summary"])).toContain("bought visibility");
    // Fixed feeds with no continuation: saying so is different from silence.
    expect(out["hasMore"]).toBe(false);
  });

  /**
   * S9-17. `returned` counts ROWS, and `recentBoosts` lists purchase EVENTS,
   * so one token that bought several boosts holds several rows: measured
   * stable across six live reads at 30 rows carrying 28 distinct tokens.
   * Nothing in the answer said so, and `returned: 30` reads as 30 tokens.
   */
  it("counts the tokens behind the rows, not only the rows", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const out = await call("dexscreener.spotlight", {});
    const window = out["providerWindow"] as Record<string, unknown>;
    const distinct = window["distinctRowsReturned"] as number;
    const duplicates = window["duplicateRowsAcrossFeeds"] as number;
    expect(typeof distinct).toBe("number");
    // The accounting closes: every row is either a distinct token or a repeat.
    expect(distinct + duplicates).toBe(out["returned"]);
    expect(distinct).toBeLessThanOrEqual(out["returned"] as number);
    expect(String(window["distinctRowsNote"])).toContain("purchase EVENTS");
  });

  it("returns only the feed asked for", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const out = await call("dexscreener.spotlight", { feed: "recentBoosts" });
    expect(out["recentBoosts"]).toBeDefined();
    expect(out["topBoosts"]).toBeUndefined();
    expect(out["latestProfiles"]).toBeUndefined();
  });

  it("keeps the just-purchased amount distinguishable from the running total", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const out = await call("dexscreener.spotlight", { feed: "recentBoosts", limit: 5 });
    const rows = out["recentBoosts"] as Record<string, unknown>[];
    expect(rows[0]?.["justPurchasedAmount"]).not.toBeNull();
    expect(rows[0]?.["totalBoostAmount"]).not.toBeNull();
  });

  it("accounts for every row it filtered out", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const out = await call("dexscreener.spotlight", { feed: "topBoosts", limit: 5 });
    const accounting = out["clientFiltering"] as Record<string, number>;
    expect(
      accounting["returned"]
        + accounting["droppedByChain"]
        + accounting["notShownByLimit"]
    ).toBe(accounting["providerReturned"]);
    expect(accounting["returned"]).toBe(5);
  });

  it("serves a limit above the feed instead of refusing it, and says the rest do not exist", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const out = await call("dexscreener.spotlight", { feed: "topBoosts", limit: 500 });
    const accounting = out["clientFiltering"] as Record<string, number>;
    expect(accounting["notShownByLimit"]).toBe(0);
    expect(out["truncated"]).toBe(false);
    expect(accounting["returned"]).toBe(accounting["providerReturned"]);
  });

  it("refuses an unknown chain rather than filtering every row away", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const result = await callRaw("dexscreener.spotlight", { chainIds: "solanaa" });
    expect(result.output).toContain("solanaa");
  });

  it("names the issuer-authored profile fields as untrusted", async () => {
    mount({ spotlight: SPOTLIGHT_BODY });
    const out = await call("dexscreener.spotlight", { fields: "description,links" });
    expect(out["externalContentFields"]).toContain(
      "latestProfiles[].description"
    );
    expect(String(out["externalContentWarning"])).toContain("TwitterAccount");
  });
});

/* ------------------------------------------------------------------ */
/* Tool 17: pairs_batch_get                                            */
/* ------------------------------------------------------------------ */

describe("parseBatchInputs", () => {
  it("puts every input in exactly one bucket and the buckets sum to what was passed", () => {
    const parsed = parseBatchInputs(
      [
        "ethereum:0xAAA",
        "ethereum:0xaaa", // same identity, different casing
        "no-separator",
        "  ",             // blank entries are not inputs at all
        ":missing-chain",
      ],
      ["solana:TOK1"]
    );
    expect(parsed.identities.map((one) => one.raw)).toEqual([
      "ethereum:0xAAA",
      "solana:TOK1",
    ]);
    expect(parsed.duplicates).toEqual(["ethereum:0xaaa"]);
    expect(parsed.invalidFormat).toEqual(["no-separator", ":missing-chain"]);
    expect(
      parsed.identities.length +
        parsed.duplicates.length +
        parsed.invalidFormat.length
    ).toBe(parsed.requested);
  });

  it("keeps a pair and a token of the same address apart", () => {
    const parsed = parseBatchInputs(["ethereum:0xAAA"], ["ethereum:0xAAA"]);
    expect(parsed.identities).toHaveLength(2);
    expect(parsed.duplicates).toEqual([]);
  });
});

describe("dexscreener.pairs.batch", () => {
  const KNOWN = "ethereum:0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";

  it("returns rows and accounting that sums to the identities requested", async () => {
    mount({ ws: [BATCH_FRAME] });
    const out = await call("dexscreener.pairs.batch", { pairs: KNOWN });
    const accounting = out["inputAccounting"] as Record<string, unknown>;
    const total =
      (accounting["resolved"] as number) +
      (accounting["invalid_format"] as string[]).length +
      (accounting["duplicates"] as string[]).length +
      (accounting["provider_omitted"] as string[]).length;
    expect(total).toBe(accounting["requested"]);
    expect(accounting["resolved"]).toBe(1);
    expect(out["returned"]).toBe(1);
    // The channel has no pagination at all, and the answer says so.
    expect(out["hasMore"]).toBe(false);
  });

  it("names an identity the provider silently left out instead of losing it", async () => {
    mount({ ws: [BATCH_FRAME] });
    const missing = "solana:NotARealPairIdAtAll";
    const out = await call("dexscreener.pairs.batch", {
      pairs: [KNOWN, missing],
    });
    const accounting = out["inputAccounting"] as Record<string, unknown>;
    expect(accounting["provider_omitted"]).toEqual([missing]);
    expect(accounting["resolved"]).toBe(1);
    expect(String(out["providerOmittedNote"])).toContain("not evidence");
  });

  it("echoes malformed and duplicated inputs rather than dropping them", async () => {
    mount({ ws: [BATCH_FRAME] });
    const out = await call("dexscreener.pairs.batch", {
      pairs: [KNOWN, KNOWN, "garbage"],
    });
    const accounting = out["inputAccounting"] as Record<string, unknown>;
    expect(accounting["duplicates"]).toEqual([KNOWN]);
    expect(accounting["invalid_format"]).toEqual(["garbage"]);
    expect(accounting["requested"]).toBe(3);
  });

  it("declares the provider-canonical basis whenever a token was passed", async () => {
    mount({ ws: [BATCH_FRAME] });
    const out = await call("dexscreener.pairs.batch", {
      tokens: "ethereum:0x6982508145454Ce325dDbE47a25d4ec3d2311933",
    });
    expect(out["resolutionBasis"]).toBe("provider_canonical");
    expect(String(out["resolutionNote"])).toContain("not necessarily the deepest");
  });

  it("does not claim a resolution basis when only pairs were passed", async () => {
    mount({ ws: [BATCH_FRAME] });
    const out = await call("dexscreener.pairs.batch", { pairs: KNOWN });
    expect(out["resolutionBasis"]).toBeUndefined();
  });

  it("accounts for rows its own thresholds removed", async () => {
    mount({ ws: [BATCH_FRAME] });
    const out = await call("dexscreener.pairs.batch", {
      pairs: KNOWN,
      minLiquidityUsd: 1e15,
    });
    const filtering = out["clientFiltering"] as Record<string, unknown>;
    expect(filtering["returned"]).toBe(0);
    expect(filtering["dropped"]).toBe(1);
    expect(
      (filtering["droppedByFilter"] as Record<string, number>)["minLiquidityUsd"]
    ).toBe(1);
    expect(
      (filtering["returned"] as number) + (filtering["dropped"] as number)
    ).toBe(filtering["providerReturned"]);
  });

  it("reports the chunking it performed", async () => {
    mount({ ws: [BATCH_FRAME] });
    const out = await call("dexscreener.pairs.batch", { pairs: KNOWN });
    const window = out["providerWindow"] as Record<string, unknown>;
    expect(window["endpoint"]).toBe("/dex/screener/v8/pairs-search");
    expect((window["chunks"] as unknown[]).length).toBe(1);
  });

  it("refuses when no identity was given at all", async () => {
    mount({ ws: [BATCH_FRAME] });
    const result = await callRaw("dexscreener.pairs.batch", {});
    expect(result.output).toContain("no pair or token identities");
  });

  it("refuses when every identity was unusable, naming the malformed ones", async () => {
    mount({ ws: [BATCH_FRAME] });
    const result = await callRaw("dexscreener.pairs.batch", { pairs: "garbage" });
    expect(result.output).toContain("garbage");
  });
});
