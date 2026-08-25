/**
 * The four deep-dive HANDLERS, driven through the real registry with a
 * scripted transport.
 *
 * The endpoint tests prove the codecs and the wire grammar. These prove the
 * part the model actually reads, and every assertion here is a rule-90
 * obligation rather than a shape check: a percentage that lost its unit, a
 * concentration figure without its coverage, an unanswered audit rendered as a
 * pass, a range summary that did not cover its range, and any field claiming
 * profit the data cannot support. Each would be an ordinary-looking answer if
 * it regressed, which is exactly why it is asserted here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import {
  decodeDexScreenerMessageToJson,
  getDexScreenerMessageDescriptor,
} from "@tools/dexscreener/codec/protobuf.js";
import { DsAvroReader } from "../../tools/dexscreener/codec/dsavro.js";
import { META_TRENDING } from "../../tools/dexscreener/codec/dsavro-schemas.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import { loadFixture, loadJsonFixture } from "./_fixtures.js";

const CHAIN = "ethereum";
const PAIR = "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";

const CATALOG = loadJsonFixture("chains-by-trending").bytes;
const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const DETAILS_ETH = loadJsonFixture("pair-details-ethereum-pepe").bytes;
const DETAILS_SOL = loadJsonFixture("pair-details-solana-live").bytes;
const HTTP_BARS = loadFixture("bars-uniswap-ethereum-h1").bytes;
const CONNECT_TRADES = loadFixture("connect-gettransactions-uniswap").bytes;
const TOP_MAKERS = loadFixture("topmakers-uniswap-ethereum").bytes;

/**
 * REAL captured liquidity events, replacing a synthetic derivation.
 *
 * The previous fixture built a joinExit row by taking a real swap row and
 * swapping its oneof arm. That was the honest thing to do while no committed
 * capture carried a real one, and it was still not enough: it kept the swap
 * row's own `swap` block and its `traderScreener`, so it could not express
 * either shape the provider actually sends. Measured on the live capture
 * behind these two fixtures (ethereum PEPE/WETH, 2026-08-25): a real joinExit
 * row carries NO `swap` block at all, so price, priceNative and volumeUSD are
 * all absent rather than merely the last one, and 3 of 100 rows carry no
 * `traderScreener` either. Both are exercised below.
 */
const CONNECT_JOIN_EXIT_ADD = loadFixture(
  "connect-trades-joinexit-add-uniswap"
).bytes;
const CONNECT_JOIN_EXIT_REMOVE = loadFixture(
  "connect-trades-joinexit-remove-uniswap"
).bytes;

let release: (() => void) | null = null;

afterEach(() => {
  release?.();
  release = null;
});

/**
 * Mount a transport that answers by URL rather than by call order.
 *
 * By URL on purpose: `fetchChainsCatalog` CACHES across calls, so the catalog
 * read happens on the first test in a file and never again. A positional
 * script would therefore hand the catalog body to whichever endpoint happened
 * to be first in the next test, which is a test-harness bug that looks exactly
 * like a decoder regression. Routing on the path removes the ordering
 * dependency entirely.
 */
function mount(body: Uint8Array, status = 200): void {
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      const isCatalog = url.includes("/ds-data/") || url.includes("chains");
      return Promise.resolve({
        url,
        status: isCatalog ? 200 : status,
        headers: new Map([["cache-control", "public, max-age=60"]]),
        body: isCatalog ? CATALOG : body,
      });
    },
    wsExchange: () => Promise.resolve([PAIR_FRAME]),
  };
  release = registerDexScreenerTransport(transport);
}

async function call(
  toolId: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  expect(handler).toBeDefined();
  if (handler === undefined) throw new Error("no handler");
  const result = await handler(params, {} as never);
  // A typed refusal comes back as `success: false` with the reason in
  // `output`. Assert on THAT field and surface the text, so a broken
  // expectation says why instead of failing later on an undefined read.
  expect(result.success, result.output).toBe(true);
  return result.data as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Pair details                                                        */
/* ------------------------------------------------------------------ */

describe("dexscreener__pair_details_get", () => {
  it("keeps the two audit providers separate and lists their disagreements", async () => {
    mount(DETAILS_ETH);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    const security = data["security"] as Record<string, unknown>;
    const byProvider = security["byProvider"] as Record<string, unknown>;
    expect(byProvider["goplus"]).not.toBeNull();
    expect(byProvider["quickintel"]).not.toBeNull();
    // Never merged into one truth set.
    expect(security).not.toHaveProperty("merged");
    expect(Array.isArray(security["conflicts"])).toBe(true);
  });

  it("carries every percentage with its provider unit and normalized value", async () => {
    mount(DETAILS_ETH);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
      fields: "security,holders",
    });
    const goplus = (
      (data["security"] as Record<string, unknown>)["byProvider"] as Record<string, unknown>
    )["goplus"] as Record<string, unknown>;
    expect(goplus["ownerShare"]).toMatchObject({ unit: "fraction" });
    expect(String(data["unitsNote"])).toContain("normalizedPct");
  });

  it("reports concentration only next to the rows it covers", async () => {
    mount(DETAILS_ETH);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
      fields: "holders",
    });
    const token = (data["holders"] as Record<string, unknown>)["token"] as Record<string, unknown>;
    // The two numbers travel on the SAME object, so one cannot be read alone.
    expect(token["rowsCovered"]).toBe(10);
    expect(typeof token["top10Pct"]).toBe("number");
    expect(token["holderCount"]).toBe(580_992);
    expect(String(token["coverageNote"])).toContain("NOT a statement about");
  });

  it("nulls tag-weighted shares when the provider tagged rows incompletely", async () => {
    mount(DETAILS_SOL);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
      fields: "holders",
    });
    const token = (data["holders"] as Record<string, unknown>)["token"] as Record<string, unknown>;
    // The Solana holder rows carry no tag at all, so a burned or contract share
    // is UNKNOWN. Zero would read as "none of it is burned", which is a claim.
    expect(token["taggingComplete"]).toBe(false);
    expect(token["burnedPct"]).toBeNull();
    expect(token["contractHeldPct"]).toBeNull();
    expect(token["unclassifiedPct"]).toBeNull();
  });

  it("renders an all-null 200 as unavailable, never as a pass", async () => {
    const allNull = new TextEncoder().encode(
      JSON.stringify({
        gp: null, qi: null, holders: null, lpHolders: null, ta: null,
        ll: null, su: null, cms: null, cg: null, cmc: null, ts: null,
        ti: null, hpi: null,
      })
    );
    mount(allNull);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    const availability = data["availability"] as Record<string, unknown>;
    expect(availability["state"]).toBe("unavailable");
    expect(availability["reason"]).toBe("not_indexed_yet");
    expect(String(availability["note"])).toContain("NOT a clean result");
    expect(String(data["summary"])).toContain("not the same as nothing being wrong");
  });

  it("names the route, because the two routes are cached separately", async () => {
    mount(DETAILS_ETH);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    const subject = data["subject"] as Record<string, unknown>;
    expect(subject["route"]).toBe("pair_id");
    expect(String(subject["routeNote"])).toContain("cached SEPARATELY");
  });

  it("emits no composite score of any kind", async () => {
    mount(DETAILS_ETH);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    // Asserted on FIELD KEYS rather than on the serialized text: the prose
    // deliberately uses these words to deny them ("a signal to read the flags
    // rather than a verdict to repeat"), so a substring ban would forbid the
    // honesty clause it is meant to protect.
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
      if (typeof value !== "object" || value === null) return;
      for (const [key, entry] of Object.entries(value)) {
        keys.add(key.toLowerCase());
        walk(entry);
      }
    };
    walk(data);
    for (const banned of ["riskscore", "safetyscore", "rugscore", "trustscore", "verdict", "score"]) {
      expect([...keys], `field named ${banned}`).not.toContain(banned);
    }
    // And the one prose claim that must be present.
    expect(String(data["noScoreNote"])).toContain("No composite risk score");
  });
});

/* ------------------------------------------------------------------ */
/* Candles                                                             */
/* ------------------------------------------------------------------ */

describe("dexscreener__candles_list", () => {
  it("returns column-oriented rows with the column names beside them", async () => {
    mount(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      resolution: "1h",
      limit: 10,
    });
    const columns = data["columns"] as string[];
    const rows = data["rows"] as unknown[][];
    expect(columns[0]).toBe("t");
    expect(rows).toHaveLength(10);
    for (const row of rows) expect(row).toHaveLength(columns.length);
    // Prices stay decimal STRINGS through the projection.
    const closeIndex = columns.indexOf("cUsd");
    expect(typeof rows[0]?.[closeIndex]).toBe("string");
  });

  it("always states whether the newest bar is still forming", async () => {
    mount(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 5,
    });
    const summary = data["summaryBlock"] as Record<string, unknown>;
    expect(summary).toHaveProperty("lastBarPartial");
    expect(typeof summary["lastBarPartial"]).toBe("boolean");
    expect(String(summary["lastBarPartialNote"]).length).toBeGreaterThan(0);
  });

  it("states the requested range against the covered one, and counts gaps", async () => {
    mount(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 20,
    });
    const summary = data["summaryBlock"] as Record<string, unknown>;
    expect(summary).toHaveProperty("requestedRange");
    expect(summary).toHaveProperty("coveredRange");
    expect(summary).toHaveProperty("rangeFullyCovered");
    expect(typeof summary["gapCount"]).toBe("number");
    expect(String(summary["gapNote"])).toContain("never filled with zero volume");
  });

  it("names the withheld token-volume fields and why, rather than omitting them silently", async () => {
    mount(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 3,
      fields: "ohlc,volume",
    });
    const withheld = data["withheldFields"] as Record<string, unknown>;
    expect(withheld["fields"]).toStrictEqual(["volumeBase", "volumeQuote", "vwap"]);
    expect(String(withheld["reason"])).toContain("power of ten");
  });

  it("reports the walk and its bounds on every answer", async () => {
    mount(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 3,
    });
    const window = data["providerWindow"] as Record<string, unknown>;
    expect(window["pagesWalked"]).toBe(1);
    expect(window["barsPerCall"]).toBe(999);
    expect(window["pageBudgetHit"]).toBe(false);
    expect(window["transport"]).toBe("http");
  });

  it("refuses a resolution outside the 18 the provider serves", async () => {
    mount(HTTP_BARS);
    const handler = DEXSCREENER_HANDLERS["dexscreener.candles"];
    const result = await handler?.({ chain: CHAIN, pairAddress: PAIR, resolution: "7h" }, {} as never);
    expect(result?.success).toBe(false);
    expect(result?.output).toContain("resolution");
  });
});

/* ------------------------------------------------------------------ */
/* Trades                                                              */
/* ------------------------------------------------------------------ */

describe("dexscreener__trades_list", () => {
  it("carries the corrected trader vocabulary and none of the wrong one", async () => {
    mount(CONNECT_TRADES);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 5,
    });
    const trades = data["trades"] as Record<string, unknown>[];
    expect(trades).toHaveLength(5);
    const profile = trades.find((t) => t["traderProfile"] !== undefined)?.[
      "traderProfile"
    ] as Record<string, unknown>;
    expect(profile).toHaveProperty("retainedBoughtPct");
    expect(profile).toHaveProperty("newOnPair");
    expect(profile).toHaveProperty("netCashFlowUsd");
    // Field KEYS, not prose: the semantics note has to be able to say
    // "no accumulating-versus-distributing label is emitted".
    for (const banned of ["realizedPnlUsd", "supplyPct", "holdingPeriodSeconds", "smartMoney", "stance"]) {
      expect(profile, `field named ${banned}`).not.toHaveProperty(banned);
    }
    expect(String(data["traderSemantics"])).toContain("NOT profit");
    expect(String(data["traderSemantics"])).toContain("never a share of token supply");
  });

  it("files a null-volume liquidity event in no size bucket and counts it as unvalued, never as a $0 trade", async () => {
    // REAL captured liquidity adds, not a derived row. A synthetic joinExit
    // built by swapping a swap row's oneof arm keeps that row's `swap` block
    // and its `traderScreener`, so it cannot exercise the two shapes the
    // provider actually sends: 100 of 100 real rows carry NO swap block at
    // all, and 3 of 100 carry no `traderScreener` either.
    mount(CONNECT_JOIN_EXIT_ADD);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      eventType: "add",
      mode: "both",
      limit: 100,
      maxPages: 1,
    });
    const trades = data["trades"] as Record<string, unknown>[];
    const addRow = trades.find((t) => t["eventType"] === "add");
    expect(addRow).toBeDefined();
    expect(addRow?.["volumeUsd"]).toBeNull();
    // The shape the synthetic fixture could not produce: no swap block means
    // no price of any kind, not merely no USD volume.
    expect(addRow?.["priceUsd"]).toBeNull();
    expect(addRow?.["priceNative"]).toBeNull();
    // ...while the token amounts ARE present, which is what makes the event
    // real rather than empty.
    expect(typeof addRow?.["amountBase"]).toBe("string");

    const block = (data["aggregate"] ?? data["pageAggregate"]) as Record<string, unknown>;
    // REVERT-DETECTOR: the old code was `Number(trade.volumeUsd ?? "")`, and
    // `Number("")` is 0 and `Number.isFinite(0)` is true, so the add landed in
    // the "0-100" bucket. This assertion goes red the moment that reverts.
    const histogram = block["sizeHistogramUsd"] as Record<string, number>;
    const zeroBucket = histogram["0-100"];
    expect(typeof zeroBucket).toBe("number");

    // Every row in this capture is a real liquidity add, so EVERY one of them
    // is unvalued. The old derived fixture had exactly one, which meant the
    // invariant was only ever exercised at the boundary of one row.
    const trueUnvaluedCount = trades.filter((t) => t["volumeUsd"] === null).length;
    expect(trueUnvaluedCount).toBe(trades.length);
    expect(block["unvaluedEvents"]).toBe(trueUnvaluedCount);
    // And the size histogram is therefore entirely EMPTY: not one of these
    // events may be filed as a zero-dollar trade.
    expect(Object.values(histogram).reduce((sum, n) => sum + n, 0)).toBe(0);

    // The stated invariant: bucket counts plus unvaluedEvents equal
    // tradeCount. This is the exact claim the sizeHistogramNote makes.
    const bucketTotal = Object.values(histogram).reduce((sum, n) => sum + n, 0);
    expect(bucketTotal + (block["unvaluedEvents"] as number)).toBe(
      block["tradeCount"]
    );
    expect(String(block["sizeHistogramNote"])).toContain(
      "bucket counts plus unvaluedEvents equal tradeCount"
    );

    // largest() must never report the null-volume row as a $0 trade.
    const largestTrades = block["largestTrades"] as Record<string, unknown>[];
    expect(
      largestTrades.some((row) => row["volumeUsd"] === null || row["eventType"] === "add")
    ).toBe(false);
  });

  it("renames the aggregate when a bound stopped it short of the range", async () => {
    // One page, a requested range far older than it, and a one-page budget.
    mount(CONNECT_TRADES);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      mode: "aggregate",
      startAtMs: 1,
      maxPages: 1,
    });
    // A summary that did not cover its range must NOT be called `aggregate`.
    expect(data).not.toHaveProperty("aggregate");
    expect(data).toHaveProperty("pageAggregate");
    const block = data["pageAggregate"] as Record<string, unknown>;
    expect(block["rangeFullyCovered"]).toBe(false);
    expect(block).toHaveProperty("coveredRange");
    expect(String(block["rangeNote"])).toContain("pageAggregate rather than aggregate");
  });

  it("computes the aggregate from the same fetch as the rows in both mode", async () => {
    mount(CONNECT_TRADES);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      mode: "both",
      limit: 10,
      // One page, because the claim under test is that BOTH shapes come from
      // the SAME fetch. A multi-page walk would prove something else, and its
      // continuation legitimately moves to the socket for the exact cursor.
      maxPages: 1,
    });
    expect((data["trades"] as unknown[])).toHaveLength(10);
    const block = (data["aggregate"] ?? data["pageAggregate"]) as Record<string, unknown>;
    expect(typeof block["netFlowUsd"]).toBe("number");
    expect(typeof block["uniqueBuyers"]).toBe("number");
    expect(block).toHaveProperty("sizeHistogramUsd");
    expect(block).toHaveProperty("largestTrades");
  });

  it("hands back an opaque cursor and refuses one bound to other filters", async () => {
    mount(CONNECT_TRADES);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      eventType: "buy",
      limit: 5,
    });
    const pagination = data["pagination"] as Record<string, unknown>;
    const cursor = pagination["nextCursor"] as string;
    expect(typeof cursor).toBe("string");
    // Opaque: the provider's internals are not parseable from the token.
    expect(cursor).not.toContain("blockNumber");
    release?.();
    release = null;

    mount(CONNECT_TRADES);
    const handler = DEXSCREENER_HANDLERS["dexscreener.trades"];
    const replayed = await handler?.(
      { chain: CHAIN, pairAddress: PAIR, eventType: "sell", cursor },
      {} as never
    );
    // Continuing a `buy` walk with a `sell` cursor would silently answer a
    // question nobody asked, so it is refused rather than honoured.
    expect(replayed?.success).toBe(false);
    expect(replayed?.output).toContain("different filter set");
  });

  it("echoes every filter that was actually sent", async () => {
    mount(CONNECT_TRADES);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      eventType: "buy",
      minVolumeUsd: 1000,
      limit: 3,
    });
    const applied = data["filtersApplied"] as Record<string, unknown>;
    expect(applied["eventType"]).toBe("buy");
    expect(applied["minVolumeUsd"]).toBe("1000");
    expect(applied["maker"]).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Top traders                                                         */
/* ------------------------------------------------------------------ */

describe("dexscreener__top_traders_list", () => {
  it("states that it is bounded and not pageable", async () => {
    mount(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 10,
    });
    const pagination = data["pagination"] as Record<string, unknown>;
    expect(pagination["mode"]).toBe("bounded_non_pageable");
    expect(pagination["hasMore"]).toBe(false);
    expect(pagination).not.toHaveProperty("nextOffset");
    expect(pagination).not.toHaveProperty("nextCursor");
    expect(String(pagination["note"])).toContain("UNREACHABLE");
  });

  it("maps the public sort onto the provider's and says so", async () => {
    mount(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      sortBy: "netCashFlowUsd",
      limit: 5,
    });
    const ordering = data["ordering"] as Record<string, unknown>;
    expect(ordering["sortBy"]).toBe("netCashFlowUsd");
    expect(ordering["providerSortKey"]).toBe("pnl");
    expect(String(ordering["note"])).toContain("wrong about what they measure");
  });

  it("names what the endpoint structurally cannot see", async () => {
    mount(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 5,
    });
    const unknowns = data["unknowns"] as Record<string, unknown>;
    const cannot = unknowns["cannotDetermine"] as string[];
    expect(cannot).toContain("profit or loss");
    expect(cannot).toContain("cost basis");
    expect(cannot).toContain("transfers in or out of the wallet");
    expect(cannot).toContain("share of token supply held");
  });

  it("emits no profit, exit or smart-money language anywhere", async () => {
    mount(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 20,
    });
    const traders = data["traders"] as Record<string, unknown>[];
    // Field KEYS, not prose: the `unknowns` block must be free to say that
    // smart-money quality is exactly what this endpoint cannot establish.
    for (const banned of [
      "pnlUsd", "realizedPnlUsd", "unrealizedProfitUsd", "smartMoney",
      "hasExited", "stillHolding", "isProfitable",
    ]) {
      expect(traders[0], `field named ${banned}`).not.toHaveProperty(banned);
    }
    expect(traders[0]).toHaveProperty("netCashFlowUsd");
    expect(traders[0]).toHaveProperty("activeSpanSeconds");
    expect(traders[0]).toHaveProperty("retainedBoughtPct");
    // The provider's own misleading rank names never reach a field name.
    expect(traders[0]).not.toHaveProperty("unrealized");
    expect(traders[0]).not.toHaveProperty("pnl");
  });

  it("carries the cohort summary with the rows it covers", async () => {
    mount(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 12,
    });
    const summary = data["summaryBlock"] as Record<string, unknown>;
    expect(summary["rowsCovered"]).toBe(12);
    expect(typeof summary["netCashFlowUsd"]).toBe("number");
    expect(String(summary["note"])).toContain("not the pair");
  });
});

/* ------------------------------------------------------------------ */
/* Shared subject contract                                             */
/* ------------------------------------------------------------------ */

describe("every deep-dive answer names its subject and how it was resolved", () => {
  const cases: readonly [string, Uint8Array][] = [
    ["dexscreener.pair.details", DETAILS_ETH],
    ["dexscreener.candles", HTTP_BARS],
    ["dexscreener.trades", CONNECT_TRADES],
    ["dexscreener.top.traders", TOP_MAKERS],
  ];

  for (const [toolId, body] of cases) {
    it(`${toolId} reports the resolved AMM id and quote token`, async () => {
      mount(body);
      const data = await call(toolId, { chain: CHAIN, pairAddress: PAIR, limit: 3 });
      const subject = data["subject"] as Record<string, unknown>;
      // Both routing keys are resolved rather than accepted, and both are
      // reported so a wrong one is diagnosable instead of silent.
      expect(typeof subject["ammId"]).toBe("string");
      expect(String(subject["ammId"]).length).toBeGreaterThan(0);
      expect(typeof subject["quoteTokenAddress"]).toBe("string");
      expect(subject["resolutionBasis"]).toBe("explicit_pair_address");
      expect(String(subject["quoteResolution"])).toContain("INVERTED");
    });
  }
});

/* ------------------------------------------------------------------ */
/* Narratives (FI8): a chain-scoped call must not present a quiet chain */
/* as an exhaustive count.                                             */
/*                                                                      */
/* `dexscreener.trending` belongs to `handlers/market-context.ts`, a    */
/* different handler family than the rest of this file. It has no      */
/* dedicated test file of its own among the files this change owns, so */
/* it is housed here rather than left unverified.                      */
/* ------------------------------------------------------------------ */

describe("dexscreener__narratives_list", () => {
  const METAS_ALL_BODY = loadFixture("metas-all").bytes;
  const METAS_TRENDING_SOLANA = loadFixture("metas-trending-solana").bytes;
  const METAS_TRENDING_UNSCOPED = loadFixture("metas-trending").bytes;

  /** Zigzag-varint encode a non-negative count, matching the dialect's writer. */
  function encodeCount(n: number): Uint8Array {
    let value = BigInt(n) * 2n;
    const bytes: number[] = [];
    for (;;) {
      const byte = Number(value & 0x7fn);
      value >>= 7n;
      if (value !== 0n) {
        bytes.push(byte | 0x80);
      } else {
        bytes.push(byte);
        break;
      }
    }
    return new Uint8Array(bytes);
  }

  /**
   * A METAS_TRENDING document derived from the real `metas-trending-solana`
   * capture, keeping only the first `keep` rows.
   *
   * The real capture carries the same 18 narratives as `metas-all`
   * (measured: zero absent), so it cannot alone discriminate FI8. Rather than
   * inventing raw bytes, this reads each row's exact byte span from the real
   * document with the production `META_TRENDING` schema and the exported
   * `DsAvroReader` (the same reader `decodeDsAvro` uses), then re-emits a
   * shorter document built ONLY from those real row byte slices plus a
   * recomputed leading count. Every kept row is byte-identical to what the
   * provider sent; only which rows are kept changes.
   */
  function truncatedTrendingDocument(keep: number): Uint8Array {
    const reader = new DsAvroReader(METAS_TRENDING_SOLANA);
    const count = reader.readCount("narratives");
    const slices: Uint8Array[] = [];
    for (let i = 0; i < count; i += 1) {
      const start = reader.position;
      META_TRENDING.read(reader);
      const end = reader.position;
      if (i < keep) slices.push(METAS_TRENDING_SOLANA.subarray(start, end));
    }
    const head = encodeCount(Math.min(keep, count));
    const out = new Uint8Array(
      head.length + slices.reduce((sum, slice) => sum + slice.length, 0)
    );
    out.set(head, 0);
    let offset = head.length;
    for (const slice of slices) {
      out.set(slice, offset);
      offset += slice.length;
    }
    return out;
  }

  /**
   * Routes by URL: chains catalog, `/metas/v1/all`, and `/metas/v1/trending`.
   *
   * `trendingHeaders` are attached to the `/metas/v1/trending` response only,
   * because that is the document `sourceObservation` describes.
   */
  function mountNarratives(
    trendingBody: Uint8Array,
    trendingHeaders?: ReadonlyMap<string, string>
  ): { urls: string[] } {
    const urls: string[] = [];
    const transport: DexScreenerTransport = {
      name: "site_bridge",
      capabilities: { site: true, publicApi: true },
      httpGet: (url) => {
        urls.push(url);
        const isMetasAll = url.includes("/metas/v1/all");
        const isCatalog =
          !isMetasAll && (url.includes("/ds-data/") || url.includes("chains"));
        const body = isCatalog
          ? CATALOG
          : isMetasAll
            ? METAS_ALL_BODY
            : trendingBody;
        const headers =
          isCatalog || isMetasAll || trendingHeaders === undefined
            ? new Map<string, string>()
            : trendingHeaders;
        return Promise.resolve({
          url,
          status: 200,
          headers,
          body,
        });
      },
      wsExchange: () => Promise.resolve([PAIR_FRAME]),
    };
    release = registerDexScreenerTransport(transport);
    return { urls };
  }

  /*
   * CONTRACT CHANGE (S8 / I10). `totalNarratives` used to be the length of
   * THIS document and `knownNarratives` the catalog's 18. They are now
   * `activeNarratives` and `totalNarratives` respectively, so that
   * `totalNarratives` is always the catalog count, the denominator in the
   * tool's own "N of 18 active" phrasing, and the manifest's long-standing
   * claim that `totalNarratives` "is an exact count of what exists" stops
   * being false on every chain-scoped call. `knownNarratives` is removed
   * rather than kept as a duplicate of `totalNarratives`.
   */
  it("names the catalog count as totalNarratives and the document's own rows as activeNarratives, and names the absent narratives", async () => {
    // 5 of the real 18 solana narratives, so the document undercounts what
    // exists by 13.
    const truncated = truncatedTrendingDocument(5);
    mountNarratives(truncated);
    const data = await call("dexscreener.trending", { chain: "solana" });
    expect(data["activeNarratives"]).toBe(5);
    // REVERT-DETECTOR: before FI8 this count was the document's own length
    // (5). It goes red the moment the extra `/metas/v1/all` call or its use
    // is removed.
    expect(data["totalNarratives"]).toBe(18);
    expect(data).not.toHaveProperty("knownNarratives");
    const absent = data["narrativesWithoutActivityOnChain"] as string[];
    expect(absent).toHaveLength(13);
    expect(absent).toContain("trump");
    expect(String(data["summary"])).toContain("5 of 18 DexScreener narratives active on solana");
    expect(String(data["summary"])).toContain("silence, not absence");
  });

  it("issues exactly one extra request for the catalog on a chain-scoped call", async () => {
    const truncated = truncatedTrendingDocument(5);
    const { urls } = mountNarratives(truncated);
    await call("dexscreener.trending", { chain: "solana" });
    const metasAllCalls = urls.filter((u) => u.includes("/metas/v1/all"));
    expect(metasAllCalls).toHaveLength(1);
  });

  it("issues NO extra catalog request on an unscoped call: the document already is the catalog", async () => {
    const { urls } = mountNarratives(METAS_TRENDING_UNSCOPED);
    const data = await call("dexscreener.trending", {});
    expect(data["activeNarratives"]).toBe(data["totalNarratives"]);
    expect(data).not.toHaveProperty("narrativesWithoutActivityOnChain");
    // REVERT-DETECTOR: a caller that fetched the catalog unconditionally
    // would fail this even though the row counts above still matched, so the
    // request itself is pinned, not merely its effect on the numbers.
    const metasAllCalls = urls.filter((u) => u.includes("/metas/v1/all"));
    expect(metasAllCalls).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- */
  /* S8 / I10: the four-chain gate is REMOVED.                        */
  /*                                                                   */
  /* CONTRACT CHANGE. Until S8 a chain whose catalog                   */
  /* `features.metas.isEnabled` was false was refused by name with     */
  /* "DexScreener serves no narratives for <slug>, so there is nothing */
  /* to aggregate there". That sentence was measured FALSE: the flag   */
  /* is the website's visibility label, and the endpoint serves real   */
  /* aggregates for chains it does not flag. Both tests below would    */
  /* have thrown that refusal before the change, so they are the       */
  /* revert-detector for it.                                           */
  /* ---------------------------------------------------------------- */

  const METAS_TRENDING_ROBINHOOD = loadFixture("metas-trending-robinhood").bytes;
  const METAS_TRENDING_ARBITRUM = loadFixture("metas-trending-arbitrum").bytes;

  it("answers a chain the site does not surface with its real aggregates instead of refusing it", async () => {
    // robinhood carries features.metas.isEnabled=false in the committed
    // catalog fixture, and this committed trending capture is the live 200
    // it answered anyway: 7 narratives led by cat at $253,793,855.
    mountNarratives(METAS_TRENDING_ROBINHOOD);
    const data = await call("dexscreener.trending", { chain: "robinhood" });
    expect(data["activeNarratives"]).toBe(7);
    expect(data["totalNarratives"]).toBe(18);
    const rows = data["rows"] as Record<string, unknown>[];
    expect(rows.map((row) => row["slug"])).toContain("cat");
    expect(String(data["summary"])).toContain(
      "7 of 18 DexScreener narratives active on robinhood"
    );
    // The label survives as a LABEL and is reported as one, so an agent can
    // still explain why the site has no page for this chain.
    const visibility = data["siteVisibility"] as Record<string, unknown>;
    expect(visibility["requestedChainSurfacedOnSite"]).toBe(false);
    expect(visibility["chainsSurfacedOnSite"]).toEqual([
      "solana",
      "bsc",
      "base",
      "ethereum",
    ]);
    expect(String(visibility["note"])).toContain("NOT a data gate");
  });

  it("answers a quiet chain as 0 of 18 active rather than refusing it", async () => {
    // The committed arbitrum capture is the provider's own quiet-chain shape:
    // HTTP 200 with a one-byte body, an Avro array of count zero.
    mountNarratives(METAS_TRENDING_ARBITRUM);
    const data = await call("dexscreener.trending", { chain: "arbitrum" });
    expect(data["activeNarratives"]).toBe(0);
    expect(data["totalNarratives"]).toBe(18);
    expect(data["rows"]).toEqual([]);
    expect(data["hasMore"]).toBe(false);
    expect(String(data["summary"])).toContain(
      "0 of 18 DexScreener narratives active on arbitrum"
    );
    expect(String(data["summary"])).toContain("QUIET chain right now, not an unsupported one");
    // Every one of the 18 is accounted for by name: the empty board is never
    // ambiguous between "quiet" and "does not exist".
    expect(data["narrativesWithoutActivityOnChain"]).toHaveLength(18);
  });

  it("refuses a slug that is not a chain at all, which is the one refusal left", async () => {
    mountNarratives(METAS_TRENDING_ARBITRUM);
    const handler = DEXSCREENER_HANDLERS["dexscreener.trending"];
    if (handler === undefined) throw new Error("no handler");
    const result = await handler({ chain: "solanaa" }, {} as never);
    expect(result.success).toBe(false);
    // S9-2: routed through the catalog's own resolver, so the refusal names
    // the value AND offers candidates, like every other chain param on this
    // surface. The bare lookup this handler used to do offered none.
    expect(String(result.output)).toContain('"solanaa"');
    expect(String(result.output)).toContain("did you mean");
    expect(String(result.output)).toContain("solana");
    // And it is no longer the metasEnabled refusal wearing a different name.
    expect(String(result.output)).not.toContain("serves no narratives");
  });

  it("reports the edge cache state read from the response headers, not a hardcoded not_cached", async () => {
    // REVERT-DETECTOR for the literal `cacheState: "not_cached"` this handler
    // carried: measured live, `/metas/v1/trending` is served under
    // `public, max-age=30` with cf-cache-status HIT and an age up to 25 s, so
    // the old value asserted freshness for a half-minute-old document.
    mountNarratives(
      METAS_TRENDING_ARBITRUM,
      new Map([
        ["cf-cache-status", "HIT"],
        ["age", "23"],
        ["cache-control", "public, max-age=30"],
      ])
    );
    const data = await call("dexscreener.trending", { chain: "arbitrum" });
    const observation = data["sourceObservation"] as Record<string, unknown>;
    expect(observation["cacheState"]).toBe("cache_hit");
    expect(observation["cacheAgeMs"]).toBe(23_000);
  });
});

/* ------------------------------------------------------------------ */
/* The subject cross-check, the lock reference, and coverage honesty   */
/* ------------------------------------------------------------------ */

const DETAILS_PULSECHAIN = loadJsonFixture(
  "pair-details-quickintel-nested-pulsechain"
).bytes;
const DETAILS_FLOKI = loadJsonFixture(
  "pair-details-lock-address-shortened-floki"
).bytes;

describe("dexscreener__pair_details_get cross-checks its own subject", () => {
  /*
   * Until this existed, nothing in the pipeline could tell whether the report
   * was about the token the caller asked for. `reportedToken` is resolved on
   * the PAIR SNAPSHOT endpoint; the audit document is fetched separately and
   * states its own subject. One orientation bug, one wrong route, one cache
   * entry answering for a different identity, and the answer is a confident
   * safety report about a different contract.
   */
  it("flags a mismatch when the audit document is about another token", async () => {
    // The subject frame resolves PEPE/WETH; the mounted document is HEX on
    // pulsechain, so the provider's own subject disagrees with the report's.
    mount(DETAILS_PULSECHAIN);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    const check = data["auditedTokenCheck"] as Record<string, unknown>;
    expect(check["mismatch"]).toBe(true);
    expect(check["addressesAgree"]).toBe(false);
    expect(String(check["note"])).toContain("MISMATCH");
    // The provider's own statement travels with the verdict, so a reader can
    // see WHICH token was analysed rather than only that something is wrong.
    expect(
      (check["quickintel"] as Record<string, unknown>)["symbol"]
    ).toBe("HEX");
  });

  it("does not flag a mismatch when the provider stated no subject of its own", async () => {
    mount(DETAILS_SOL);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    const check = data["auditedTokenCheck"] as Record<string, unknown>;
    // Unverified is not verified, and the note has to say which one it is.
    expect(check["mismatch"]).toBe(false);
    expect(check["addressesAgree"]).toBeNull();
    expect(String(check["note"])).toContain("could not be cross-checked");
  });

  it("surfaces the nested QuickIntel risk family to the model", async () => {
    mount(DETAILS_PULSECHAIN);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    const quickintel = (
      (data["security"] as Record<string, unknown>)["byProvider"] as Record<string, unknown>
    )["quickintel"] as Record<string, unknown>;
    // These arrived on every live document and reached the model on none.
    expect(quickintel).toHaveProperty("hasExternalContractRisk");
    expect(quickintel).toHaveProperty("hasGeneralVulnerabilities");
    expect(quickintel).toHaveProperty("hasObfuscatedAddressRisk");
    expect(quickintel).toHaveProperty("canMultiBlacklist");
    expect(quickintel["tokenSupplyBurned"]).toBe("12575428.18160413");
    // And what is still not projected is named with its path, not omitted.
    expect(quickintel["providerFieldsNotProjected"]).toContain(
      "quickiAudit.contractLinks"
    );
  });

  it("labels a shortened lock reference instead of calling it an address", async () => {
    mount(DETAILS_FLOKI);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
      fields: "liquidityLocks",
    });
    const locks = data["liquidityLocks"] as Record<string, unknown>;
    const rows = locks["rows"] as Record<string, unknown>[];
    expect(rows[0]?.["providerLockRef"]).toBe(
      "1-0x663a5c229c09b049e36dcc11a9b0d4a8eb9db2"
    );
    expect(rows[0]?.["address"]).toBeNull();
    expect(locks["lockRefsWithoutUsableAddress"]).toBe(1);
    expect(String(locks["lockRefNote"])).toContain("Never paste");
  });

  it("says coverage is one cache entry's reading rather than a fact about the token", async () => {
    mount(DETAILS_ETH);
    const data = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    const coverage = data["coverage"] as Record<string, unknown>;
    expect(coverage["pointInTime"]).toBe(true);
    // Measured: the same subject five minutes apart answered with different
    // non-null block sets, so "absent" can be an artefact of the entry.
    expect(String(coverage["pointInTimeNote"])).toContain("FLAPS");
  });
});

describe("real liquidity events carry shapes a derived fixture cannot produce", () => {
  it("survives a row with no traderScreener at all, without inventing a profile", async () => {
    /*
     * Measured on the live capture: 3 of 100 real liquidity adds carry no
     * `traderScreener` block. The synthetic fixture this replaced always had
     * one, because it was built from a swap row that did. A profile invented
     * for a wallet the provider said nothing about would be a fabricated
     * counterparty claim on a money path.
     */
    mount(CONNECT_JOIN_EXIT_ADD);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      eventType: "add",
      limit: 100,
      traderProfile: "full",
    });
    const trades = data["trades"] as Record<string, unknown>[];
    expect(trades).toHaveLength(100);
    const withoutProfile = trades.filter((t) => !("traderProfile" in t));
    expect(withoutProfile.length).toBeGreaterThan(0);
    // The rows that DO have one still carry it in full, so the absence is the
    // provider's silence rather than the projection giving up on the page.
    expect(trades.length - withoutProfile.length).toBeGreaterThan(0);
  });

  it("projects a real remove exactly as it projects a real add", async () => {
    mount(CONNECT_JOIN_EXIT_REMOVE);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      eventType: "remove",
      mode: "aggregate",
      limit: 100,
      maxPages: 1,
    });
    const block = (data["aggregate"] ?? data["pageAggregate"]) as Record<string, unknown>;
    expect(block["liquidityRemoves"]).toBe(100);
    expect(block["liquidityAdds"]).toBe(0);
    // Not one of them is a buy, a sell, or a dollar of flow.
    expect(block["buys"]).toBe(0);
    expect(block["sells"]).toBe(0);
    expect(block["buyVolumeUsd"]).toBe(0);
    expect(block["unvaluedEvents"]).toBe(100);
  });

  it("counts the permanently-null marketCapUsd rather than assuming it", async () => {
    mount(CONNECT_TRADES);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 100,
    });
    const window = data["providerWindow"] as Record<string, unknown>;
    // Measured 0 of 300 live rows across two chains and two AMM classes, and
    // 0 of 400 on the S8 re-measurement. The count is here so the day the
    // provider starts populating it is visible instead of invisible.
    expect(window["rowsWithMarketCapUsd"]).toBe(0);
    expect(String(window["marketCapNote"])).toContain("NEVER populated");
  });
});
