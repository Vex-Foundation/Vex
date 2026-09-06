/**
 * CONTINUATION AND TRUNCATION on the three microstructure tools.
 *
 * Every test here exists because a live probe through the real handler chain
 * found the surface losing data that looked perfectly ordinary in the answer:
 *
 *  - trades at `limit: 25` returned provider rows 1-25 and a cursor built from
 *    provider row 100, so rows 26-100 were reachable by no request at all;
 *  - a requested candle range returned the newest 25 of 999 in-range bars with
 *    `truncated: false`, and its `nextBeforeBlock` was accepted by no parameter
 *    the manifest declares;
 *  - `currentHoldingValueUsd` was promised, sorted by, and absent from all 100
 *    rows of a fresh unrealized rank.
 *
 * The trades walk is driven over a FAKE PROVIDER that applies the exact-cursor
 * semantics to the archived 100-row capture: the second page is what the real
 * provider was measured returning for that cursor (zero overlap, all new
 * rows), so a gap or a duplicate between the two pages is a defect in this
 * repository's cursor arithmetic and nothing else.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fromJson, toBinary, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "@vex-agent/tools/protocols/dexscreener/manifest.js";
import {
  decodeDexScreenerMessageToJson,
  getDexScreenerMessageDescriptor,
} from "@tools/dexscreener/codec/protobuf.js";
import { multiplyDecimalStrings } from "@tools/dexscreener/endpoints/top-traders.js";
import { roundUsdCents } from "@vex-agent/tools/protocols/dexscreener/handlers/deep-dive/top-traders.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import { loadFixture, loadJsonFixture } from "./_fixtures.js";
import { makeProtocolContext } from "../vex-agent/tools/_test-context.js";

const CHAIN = "ethereum";
const PAIR = "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";
const MAX_BYTES = 1_000_000;

const CATALOG = loadJsonFixture("chains-by-trending").bytes;
const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const CONNECT_TRADES = loadFixture("connect-gettransactions-uniswap").bytes;
const HTTP_BARS = loadFixture("bars-uniswap-ethereum-h1").bytes;
const TOP_MAKERS = loadFixture("topmakers-uniswap-ethereum").bytes;

/** The archived provider page, in the provider's own newest-first order. */
const ARCHIVED_TRADES: readonly JsonObject[] = (() => {
  const decoded = decodeDexScreenerMessageToJson(
    "dex_feed.GetTransactionsResponse",
    CONNECT_TRADES,
    { maxBytes: MAX_BYTES }
    // The decoder returns parsed JSON, so its rows ARE JsonObjects; naming
    // that here keeps the re-encode below cast-free.
  ) as { readonly transactions?: readonly JsonObject[] };
  return decoded.transactions ?? [];
})();

let release: (() => void) | null = null;

afterEach(() => {
  release?.();
  release = null;
});

/** Identity of one archived row, stable across the two channels. */
function rowKey(row: JsonObject): string {
  return `${String(row["blockNumber"])}:${String(row["transactionIndex"])}:${String(row["eventIndex"])}`;
}

/** Identity of one row as the handler shaped it for the model. */
function tradeKey(trade: Record<string, unknown>): string {
  return `${String(trade["transactionId"])}:${String(trade["blockNumber"])}`;
}

/** The same identity from the raw provider row: `id` is the transaction hash. */
function archivedKeyByTransaction(row: JsonObject): string {
  return `${String(row["id"])}:${String(row["blockNumber"])}`;
}

/**
 * A provider that serves the archived page over Connect and honours the exact
 * cursor over the socket, exactly as the live provider was measured doing.
 */
function mountTradesProvider(): { readonly urls: string[] } {
  const urls: string[] = [];
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      urls.push(url);
      const isCatalog = url.includes("/ds-data/") || url.includes("chains");
      return Promise.resolve({
        url,
        status: 200,
        headers: new Map<string, string>(),
        body: isCatalog ? CATALOG : CONNECT_TRADES,
      });
    },
    wsExchange: (_url, options) => {
      const command = options.send?.[0];
      // The transport may carry a text frame; only a binary one can be a
      // protobuf command, and anything else is the subject-resolution ask.
      if (command === undefined || typeof command === "string") {
        return Promise.resolve([PAIR_FRAME]);
      }
      let arm: Record<string, unknown> | undefined;
      try {
        const decoded = decodeDexScreenerMessageToJson(
          "dex_feed.WSCommand",
          command,
          { maxBytes: MAX_BYTES }
        ) as Record<string, unknown>;
        arm = decoded["getHistoricalTransactions"] as
          | Record<string, unknown>
          | undefined;
      } catch {
        arm = undefined;
      }
      // Not a trades command: this is the subject resolution asking the pair
      // channel, which the archived pair frame answers.
      if (arm === undefined) return Promise.resolve([PAIR_FRAME]);
      const before = arm["before"] as Record<string, unknown> | undefined;
      const cid = Number(arm["cid"] ?? 0);
      let rows = ARCHIVED_TRADES;
      if (before !== undefined) {
        const wanted = `${String(before["blockNumber"])}:${String(before["transactionIndex"] ?? 0)}:${String(before["eventIndex"] ?? 0)}`;
        const at = ARCHIVED_TRADES.findIndex((row) => rowKey(row) === wanted);
        // The provider resumes STRICTLY BEFORE the cursor event, so an unknown
        // position returns nothing rather than the whole page again.
        rows = at === -1 ? [] : ARCHIVED_TRADES.slice(at + 1);
      }
      const descriptor = getDexScreenerMessageDescriptor("dex_feed.WSMessage");
      const frame = toBinary(
        descriptor,
        fromJson(descriptor, {
          historicalTransactions: { cid, transactions: [...rows] },
        } satisfies JsonValue)
      );
      return Promise.resolve([frame]);
    },
  };
  release = registerDexScreenerTransport(transport);
  return { urls };
}

/** A provider that serves one body for every non-catalog read. */
function mountSingle(body: Uint8Array): { readonly urls: string[] } {
  const urls: string[] = [];
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      urls.push(url);
      const isCatalog = url.includes("/ds-data/") || url.includes("chains");
      return Promise.resolve({
        url,
        status: 200,
        headers: new Map<string, string>(),
        body: isCatalog ? CATALOG : body,
      });
    },
    wsExchange: () => Promise.resolve([PAIR_FRAME]),
  };
  release = registerDexScreenerTransport(transport);
  return { urls };
}

async function call(
  toolId: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  expect(handler).toBeDefined();
  if (handler === undefined) throw new Error("no handler");
  const result = await handler(params, makeProtocolContext());
  expect(result.success, result.output).toBe(true);
  return result.data as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Trades: the cursor is the last EMITTED row                          */
/* ------------------------------------------------------------------ */

describe("dexscreener__trades_list continuation", () => {
  for (const limit of [1, 10, 25, 40]) {
    it(`walks two pages at limit ${limit} with no skipped and no repeated row`, async () => {
      mountTradesProvider();
      const first = await call("dexscreener.trades", {
        chain: CHAIN,
        pairAddress: PAIR,
        limit,
      });
      const firstRows = first["trades"] as Record<string, unknown>[];
      expect(firstRows).toHaveLength(limit);
      const pagination = first["pagination"] as Record<string, unknown>;
      expect(pagination["hasMore"]).toBe(true);
      expect(pagination["rowsWithheldByLimit"]).toBe(
        ARCHIVED_TRADES.length - limit
      );
      const cursor = pagination["nextCursor"] as string;
      expect(typeof cursor).toBe("string");
      release?.();
      release = null;

      mountTradesProvider();
      const second = await call("dexscreener.trades", {
        chain: CHAIN,
        pairAddress: PAIR,
        limit,
        cursor,
      });
      const secondRows = second["trades"] as Record<string, unknown>[];
      expect(secondRows).toHaveLength(limit);

      const walked = [...firstRows, ...secondRows].map(tradeKey);
      const expectedKeys = ARCHIVED_TRADES.slice(0, limit * 2).map(
        archivedKeyByTransaction
      );
      // ZERO DUPLICATES OF OUR OWN. Compared against the provider's own
      // distinct count rather than against the row count, because ONE
      // transaction can legitimately carry two events and the emitted row
      // shape identifies a row by transaction and block.
      expect(new Set(walked).size).toBe(new Set(expectedKeys).size);
      // ZERO GAPS: the two pages are exactly the provider's first 2 * limit
      // rows, in the provider's own order. A cursor taken from the last
      // FETCHED row instead of the last EMITTED one skips the rows between
      // them and fails right here.
      expect(walked).toStrictEqual(expectedKeys);
    });
  }

  it("builds the cursor from the last row it returned, not the last row it fetched", async () => {
    mountTradesProvider();
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 25,
    });
    const pagination = data["pagination"] as Record<string, unknown>;
    expect(pagination["rowsFetched"]).toBe(ARCHIVED_TRADES.length);
    expect(pagination["rowsReturned"]).toBe(25);
    const decoded = JSON.parse(
      Buffer.from(pagination["nextCursor"] as string, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const emitted = ARCHIVED_TRADES[24];
    const fetched = ARCHIVED_TRADES[ARCHIVED_TRADES.length - 1];
    expect(emitted).toBeDefined();
    expect(fetched).toBeDefined();
    expect(String(decoded["b"])).toBe(String(emitted?.["blockNumber"]));
    expect(String(decoded["t"])).toBe(String(emitted?.["transactionIndex"]));
    expect(String(decoded["e"])).toBe(String(emitted?.["eventIndex"]));
    // The measured defect, named: the cursor was the oldest FETCHED row.
    expect(String(decoded["b"])).not.toBe(String(fetched?.["blockNumber"]));
  });

  it("keeps the provider's own cursor when nothing was held back", async () => {
    mountTradesProvider();
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 100,
    });
    const pagination = data["pagination"] as Record<string, unknown>;
    expect(pagination["rowsWithheldByLimit"]).toBe(0);
    const decoded = JSON.parse(
      Buffer.from(pagination["nextCursor"] as string, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const oldest = ARCHIVED_TRADES[ARCHIVED_TRADES.length - 1];
    expect(String(decoded["b"])).toBe(String(oldest?.["blockNumber"]));
  });

  it("accepts a page budget above the removed 1,000-page ceiling", async () => {
    mountTradesProvider();
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      mode: "aggregate",
      maxPages: 1_001,
      startAtMs: 1,
    });
    expect((data["providerWindow"] as Record<string, unknown>)["maxPages"]).toBe(
      1_001
    );
  });
});

/* ------------------------------------------------------------------ */
/* Candles: a withheld bar is truncation and its cursor is callable    */
/* ------------------------------------------------------------------ */

describe("dexscreener__candles_list continuation", () => {
  it("declares a beforeBlock parameter that accepts nextBeforeBlock", () => {
    const manifest = DEXSCREENER_TOOLS.find(
      (tool) => tool.toolId === "dexscreener.candles"
    );
    expect(manifest).toBeDefined();
    const keys = (manifest?.params ?? []).map((param) => param.key);
    expect(keys).toContain("beforeBlock");
  });

  it("reports truncated and a callable cursor when limit holds back in-range bars", async () => {
    const provider = mountSingle(HTTP_BARS);
    const first = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      resolution: "1h",
      startAtMs: 1,
      limit: 25,
      maxPages: 1,
    });
    const rows = first["rows"] as unknown[][];
    expect(rows).toHaveLength(25);
    // The measured defect: 25 of 999 in-range bars returned as NOT truncated.
    expect(first["truncated"]).toBe(true);
    expect(first["barsWithheldByLimit"]).toBe(974);
    const summary = first["summaryBlock"] as Record<string, unknown>;
    expect(summary["rangeFullyCovered"]).toBe(false);
    expect(String(first["truncationNote"])).toContain("beforeBlock");

    // The cursor continues from the OLDEST BAR RETURNED, so the 974 withheld
    // bars are on the other side of it rather than below the fetched floor.
    const columns = first["columns"] as string[];
    const nextBeforeBlock = first["nextBeforeBlock"] as number;
    expect(typeof nextBeforeBlock).toBe("number");
    const oldestReturnedAtMs = rows[0]?.[columns.indexOf("t")] as number;
    expect(oldestReturnedAtMs).toBeGreaterThan(0);

    // Feeding it back through the declared parameter reaches the provider as
    // its own exclusive block anchor and answers a page.
    provider.urls.length = 0;
    const second = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      resolution: "1h",
      limit: 25,
      beforeBlock: nextBeforeBlock,
    });
    expect((second["rows"] as unknown[][]).length).toBeGreaterThan(0);
    const barUrls = provider.urls.filter((url) => url.includes("/bars/"));
    expect(barUrls.length).toBeGreaterThan(0);
    expect(barUrls.every((url) => url.includes(`bbn=${nextBeforeBlock}`))).toBe(
      true
    );
  });

  it("calls a row cut truncation even when the walk covered the whole range", async () => {
    mountSingle(HTTP_BARS);
    // A range the FIRST page already covers, so no walk bound is hit and the
    // only thing holding bars back is the row bound. This is the exact shape
    // the live probe found reporting truncated false while returning 25 of
    // 999 in-range bars.
    const full = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      resolution: "1h",
      limit: 999,
    });
    const fullRows = full["rows"] as unknown[][];
    const timeIndex = (full["columns"] as string[]).indexOf("t");
    const insideRangeStart = fullRows[fullRows.length - 200]?.[
      timeIndex
    ] as number;
    expect(typeof insideRangeStart).toBe("number");
    expect(full["truncated"]).toBe(false);

    const cut = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      resolution: "1h",
      startAtMs: insideRangeStart,
      limit: 25,
    });
    const window = cut["providerWindow"] as Record<string, unknown>;
    // The walk itself was satisfied: no page budget, no deadline.
    expect(window["pageBudgetHit"]).toBe(false);
    expect(window["deadlineHit"]).toBe(false);
    // ... and the answer still says data was withheld, with a cursor for it.
    expect(cut["truncated"]).toBe(true);
    expect(cut["barsWithheldByLimit"]).toBe(175);
    expect(typeof cut["nextBeforeBlock"]).toBe("number");
    expect(
      (cut["summaryBlock"] as Record<string, unknown>)["rangeFullyCovered"]
    ).toBe(false);
  });

  it("lets startAtMs outrank the default limit instead of returning the newest page", async () => {
    mountSingle(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      resolution: "1h",
      startAtMs: 1,
      maxPages: 1,
    });
    // With a range and no explicit limit the row bound is the provider's own
    // page, not the modest default of 100.
    expect((data["rows"] as unknown[][]).length).toBeGreaterThan(100);
    expect(data["barsWithheldByLimit"]).toBe(0);
  });

  it("refuses beforeBlock together with endAtMs rather than silently picking one", async () => {
    mountSingle(HTTP_BARS);
    const handler = DEXSCREENER_HANDLERS["dexscreener.candles"];
    const result = await handler?.(
      {
        chain: CHAIN,
        pairAddress: PAIR,
        beforeBlock: 25_524_766,
        endAtMs: 1_780_000_000_000,
      },
      makeProtocolContext()
    );
    expect(result?.success).toBe(false);
    expect(result?.output).toContain("beforeBlock");
  });

  it("accepts a page budget above the removed 1,000-page ceiling", async () => {
    mountSingle(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 5,
      maxPages: 1_001,
    });
    expect((data["providerWindow"] as Record<string, unknown>)["maxPages"]).toBe(
      1_001
    );
  });
});

/* ------------------------------------------------------------------ */
/* Top traders: the promised holding value, derived exactly            */
/* ------------------------------------------------------------------ */

describe("dexscreener__top_traders_list currentHoldingValueUsd", () => {
  it("multiplies decimal strings exactly and refuses a lexeme it cannot parse", () => {
    // Exact by construction. These are a real captured balance and a real
    // captured pair price: the float product is 1210765.4590303008 and loses
    // the last three digits of the true value below.
    expect(multiplyDecimalStrings("298880636640.41", "0.000004051")).toBe(
      "1210765.45903030091"
    );
    expect(multiplyDecimalStrings("0.1", "0.2")).toBe("0.02");
    expect(multiplyDecimalStrings("2", "0.5")).toBe("1");
    expect(multiplyDecimalStrings("1e5", "2")).toBeNull();
    expect(multiplyDecimalStrings("-1", "2")).toBeNull();
    expect(multiplyDecimalStrings(`1${"0".repeat(80)}`, "2")).toBeNull();
  });

  it("emits the value on every row with both factors beside it", async () => {
    mountSingle(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      sortBy: "currentHoldingValueUsd",
      limit: 100,
    });
    const traders = data["traders"] as Record<string, unknown>[];
    expect(traders.length).toBeGreaterThan(0);
    for (const trader of traders) {
      expect(trader).toHaveProperty("currentHoldingValueUsd");
      const basis = trader["currentHoldingValueBasis"] as Record<string, unknown>;
      expect(basis["pairObservedRetainedAmount"]).toBe(
        trader["pairObservedRetainedAmount"]
      );
      expect(typeof basis["pairPriceUsd"]).toBe("string");
      const value = trader["currentHoldingValueUsd"];
      if (trader["pairObservedRetainedAmount"] === null) {
        // Never approximated and never zero: a missing input is named.
        expect(value).toBeNull();
        expect(basis["missingInputs"]).toStrictEqual([
          "pairObservedRetainedAmount",
        ]);
      } else {
        expect(typeof value).toBe("string");
        /*
         * THE EXACT PRODUCT IS KEPT; THE DISPLAYED FIGURE IS ROUNDED TO CENTS.
         *
         * The multiplication is exact over the lexemes the provider gave, and
         * `exactProductUsd` carries every digit of it. But the INPUT is
         * already a provider rounding: the retained amount arrives carrying about
         * 15 to 16 SIGNIFICANT digits whatever the token's decimals and
         * wherever the decimal point falls (measured `1464600134847.065`, and
         * `0.0001992` running to seven decimal places to reach the same
         * precision), so emitting an 18-significant-digit product as the
         * headline value claimed precision the inputs cannot support.
         */
        const exact = multiplyDecimalStrings(
          String(trader["pairObservedRetainedAmount"]),
          String(basis["pairPriceUsd"])
        );
        expect(basis["exactProductUsd"]).toBe(exact);
        expect(value).toBe(roundUsdCents(exact));
        // A decimal string, never an exponent form a float would produce, and
        // never more than two fractional digits on the displayed value.
        expect(String(value)).toMatch(/^\d+\.\d{2}$/u);
      }
    }
    // The measured defect: rows ranked by this value carried none of it.
    const derived = traders.filter(
      (trader) => trader["currentHoldingValueUsd"] !== null
    );
    expect(derived.length).toBeGreaterThan(0);
  });

  it("refuses a lookback beyond the provider's measured 30-day maximum, by name", async () => {
    mountSingle(TOP_MAKERS);
    const handler = DEXSCREENER_HANDLERS["dexscreener.top.traders"];
    expect(handler).toBeDefined();
    if (handler === undefined) throw new Error("no handler");
    const result = await handler(
      { chain: CHAIN, pairAddress: PAIR, lookbackDays: 31, limit: 5 },
      makeProtocolContext()
    );
    expect(result.success).toBe(false);
    // Refused by the NAME of the offending parameter and the exact bound, not
    // a generic provider error.
    expect(result.output).toMatch(/"lookbackDays" must be a whole number from 1 to 30; received 31/u);
    // The refusal states the measured provider reason and must not blame the
    // AMM id or quote token the caller got right.
    expect(result.output).toContain("measured");
    expect(result.output).not.toContain("AMM id");
    expect(result.output).not.toContain("quote token");
  });

  it("refuses a lookback far above the removed 3,650-day ceiling the same way", async () => {
    mountSingle(TOP_MAKERS);
    const handler = DEXSCREENER_HANDLERS["dexscreener.top.traders"];
    expect(handler).toBeDefined();
    if (handler === undefined) throw new Error("no handler");
    const result = await handler(
      { chain: CHAIN, pairAddress: PAIR, lookbackDays: 3_651, limit: 5 },
      makeProtocolContext()
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/"lookbackDays" must be a whole number from 1 to 30; received 3651/u);
  });

  it("echoes a valid lookback in filtersApplied", async () => {
    mountSingle(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      lookbackDays: 7,
      limit: 5,
    });
    expect(
      (data["filtersApplied"] as Record<string, unknown>)["lookbackDays"]
    ).toBe(7);
  });

  it("echoes the effective 30-day window when lookbackDays is omitted, never null", async () => {
    mountSingle(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 5,
    });
    // The measured defect: omitting it used to be reported as an all-time
    // leaderboard (null) when the provider actually served a 30-day window.
    expect(
      (data["filtersApplied"] as Record<string, unknown>)["lookbackDays"]
    ).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* The candle summary and the provider's own inconsistency            */
/* ------------------------------------------------------------------ */

describe("dexscreener__candles_list summary extremes", () => {
  /*
   * THE PROVIDER'S ROWS DISAGREE WITH THEMSELVES AND THE SUMMARY MUST NOT.
   *
   * Measured 2026-08-25 across 999 non-inverted hourly bars: 382 rows carried
   * an `openUsd` or `closeUsd` OUTSIDE their own `[lowUsd, highUsd]` (row
   * 1784037600000: openUsd 0.000002874 against highUsd 0.000002871), and 166
   * rows showed the same on the native columns. On an inverted series it is
   * 183 of 200. `findExtremes` read only the h/l columns, so `summary.high`
   * could come back BELOW a close printed two lines down in the same answer.
   */
  it("never reports a high below, or a low above, a value it printed", async () => {
    mountSingle(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      resolution: "1h",
      limit: 999,
      priceBasis: "usd",
    });
    const columns = data["columns"] as string[];
    const rows = data["rows"] as (string | number | null)[][];
    const summary = data["summaryBlock"] as Record<string, unknown>;
    const high = Number(summary["high"]);
    const low = Number(summary["low"]);
    expect(Number.isFinite(high)).toBe(true);
    expect(Number.isFinite(low)).toBe(true);

    // EVERY price cell of EVERY emitted row, not just the extremes columns.
    const priceColumns = ["oUsd", "hUsd", "lUsd", "cUsd"]
      .map((name) => columns.indexOf(name))
      .filter((index) => index >= 0);
    expect(priceColumns.length).toBe(4);
    let checked = 0;
    for (const row of rows) {
      for (const index of priceColumns) {
        const cell = row[index];
        if (cell === null || cell === undefined) continue;
        const value = Number(cell);
        if (!Number.isFinite(value)) continue;
        checked += 1;
        expect(value).toBeLessThanOrEqual(high);
        expect(value).toBeGreaterThanOrEqual(low);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("returns the provider's own lexeme as the extreme, never a re-rendered number", async () => {
    mountSingle(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      resolution: "1h",
      limit: 999,
    });
    const summary = data["summaryBlock"] as Record<string, unknown>;
    // A decimal string with no exponent: a float round-trip would produce one
    // at these magnitudes, and these are money.
    expect(String(summary["high"])).toMatch(/^\d+(\.\d+)?$/u);
    expect(String(summary["low"])).toMatch(/^\d+(\.\d+)?$/u);
  });

  it("tells the model the USD columns are a derived rendering", async () => {
    mountSingle(HTTP_BARS);
    const data = await call("dexscreener.candles", {
      chain: CHAIN,
      pairAddress: PAIR,
      resolution: "1h",
      limit: 5,
    });
    const summary = data["summaryBlock"] as Record<string, unknown>;
    // Both facts, because either alone is misleading: the fold explains why
    // the summary is trustworthy, the USD note explains why the ROWS may
    // still disagree with each other by about a percent.
    expect(String(summary["extremesNote"])).toContain("open and close included");
    expect(String(summary["usdConsistencyNote"])).toContain(
      "DERIVED RENDERING"
    );
    expect(String(summary["usdConsistencyNote"])).toContain("native");
  });
});

describe("dexscreener__top_traders_list reports whether its holding value is derivable", () => {
  it("counts the rows that carried a balance, on the page and on the leaderboard", async () => {
    /*
     * Retained-amount nullity is SORT-CORRELATED, which nothing said. Measured
     * null counts out of 100: currentHoldingValueUsd 0, netCashFlowUsd asc 0,
     * boughtUsd desc 58, and boughtUsd asc and netCashFlowUsd desc BOTH 100 of
     * 100. So on two of the eight sort and direction combinations every row's
     * holding value is null while the description sells that column at length.
     */
    mountSingle(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      sortBy: "currentHoldingValueUsd",
      limit: 10,
    });
    const coverage = data["balanceCoverage"] as Record<string, unknown>;
    const traders = data["traders"] as Record<string, unknown>[];
    expect(coverage["rowsReturned"]).toBe(traders.length);
    // The count is over the RETURNED rows and is checkable against them.
    expect(coverage["balancePresent"]).toBe(
      traders.filter((row) => row["pairObservedRetainedAmount"] !== null).length
    );
    // ...and the leaderboard figure covers everything fetched, not just shown.
    expect(coverage["leaderboardSize"]).toBe(data["leaderboardSize"]);
    expect(String(coverage["note"])).toContain("100 nulls");
  });

  it("says label and url are effectively never populated, and counts them", async () => {
    mountSingle(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      limit: 10,
    });
    const coverage = data["labelCoverage"] as Record<string, unknown>;
    // Measured empty on 100 percent of 1,300 live rows across four pairs.
    expect(coverage["labelPresent"]).toBe(0);
    expect(coverage["urlPresent"]).toBe(0);
    expect(String(coverage["note"])).toContain("1,300 live rows");
  });
});
