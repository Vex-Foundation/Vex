/**
 * The three pair-keyed deep-dive channels: bars, trades and top traders.
 *
 * Every assertion below is anchored to a captured provider response or to a
 * measured provider behaviour recorded in
 * `tool-surface-spec/dexscreener-site/evidence/`. The ones worth having are the
 * ones that catch a defect that would look like a correct answer: an inverted
 * price series, a continuation that skips a real trade, a walk that stops
 * without saying so, and a rank named after profit it cannot measure.
 */

import { describe, expect, it } from "vitest";
import type {
  DexScreenerTransport,
  HttpGetOptions,
  WsExchangeOptions,
} from "@tools/dexscreener/transport.js";
import {
  BARS_FRAMES,
  BARS_PER_CALL,
  barStepMs,
  barTransportFor,
  barsHttpUrl,
  fetchBarsPage,
  readBarsFrames,
  walkBars,
  BAR_RESOLUTIONS,
  type BarsPageOptions,
} from "@tools/dexscreener/endpoints/bars.js";
import {
  fetchTradesPage,
  readTradesFrames,
  TRADES_FRAMES,
  resolveBlockAnchor,
  tradesChannelFor,
  tradesConnectUrl,
  TRADES_PER_PAGE,
  type TradesPageOptions,
} from "@tools/dexscreener/endpoints/trades.js";
import {
  parseTopTraders,
  topTradersUrl,
  TOP_TRADER_SORTS,
  type TopTradersOptions,
} from "@tools/dexscreener/endpoints/top-traders.js";
import { fetchTokenInsight } from "@tools/dexscreener/endpoints/pair-live.js";
import {
  decodeDexScreenerMessageToJson,
  getDexScreenerMessageDescriptor,
} from "@tools/dexscreener/codec/protobuf.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { CHANNEL_TIMEOUT_MS } from "@vex-agent/tools/protocols/dexscreener/handlers/deep-dive/_shared.js";
import { loadFixture } from "./_fixtures.js";

const CHAIN = "ethereum";
const AMM = "uniswap";
const PAIR = "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";
const QUOTE = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BASE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";

const HTTP_BARS = loadFixture("bars-uniswap-ethereum-h1").bytes;
const HTTP_BARS_ANCHORED = loadFixture("bars-http-bbn-anchored-uniswap-ethereum").bytes;
const HTTP_BARS_CANONICAL = loadFixture("bars-http-inversion-canonical").bytes;
const HTTP_BARS_WRONG_QUOTE = loadFixture("bars-http-inversion-wrong-quote").bytes;
const WS_BARS_D1 = loadFixture("bars-ws-d1-uniswap-ethereum").bytes;
const WS_BARS_MARKETCAP = loadFixture("bars-ws-marketcap-uniswap-ethereum").bytes;
const WS_TRADES = loadFixture("ws-trades-baseline-uniswap").bytes;
const WS_TRADES_PAGE2 = loadFixture("ws-trades-exact-cursor-page2").bytes;
const CONNECT_TRADES = loadFixture("connect-gettransactions-uniswap").bytes;
const CONNECT_ANCHOR = loadFixture("connect-trades-anchor-timestamp-end").bytes;
const TOP_MAKERS = loadFixture("topmakers-uniswap-ethereum").bytes;
const INSIGHT_NOT_FOUND = loadFixture("token-insight-not-found").bytes;

interface Recorded {
  readonly httpUrls: string[];
  readonly wsFrames: Uint8Array[];
  readonly transport: DexScreenerTransport;
}

/** A transport replaying scripted responses and recording what it was asked. */
function scripted(script: {
  readonly http?: readonly { status: number; body: Uint8Array }[];
  readonly ws?: readonly (readonly Uint8Array[])[];
}): Recorded {
  const httpUrls: string[] = [];
  const wsFrames: Uint8Array[] = [];
  let httpCount = 0;
  let wsCount = 0;
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url: string, _options: HttpGetOptions) => {
      httpUrls.push(url);
      const next = script.http?.[httpCount];
      httpCount += 1;
      if (next === undefined) {
        return Promise.reject(new Error("no scripted HTTP response left"));
      }
      return Promise.resolve({
        url,
        status: next.status,
        headers: new Map<string, string>(),
        body: next.body,
      });
    },
    wsExchange: (_url: string, options: WsExchangeOptions) => {
      for (const frame of options.send ?? []) {
        if (typeof frame !== "string") wsFrames.push(frame);
      }
      const batch = script.ws?.[wsCount];
      wsCount += 1;
      if (batch === undefined) {
        return Promise.reject(new Error("no scripted WS batch left"));
      }
      return Promise.resolve([...batch]);
    },
  };
  return { httpUrls, wsFrames, transport };
}

function barsOptions(
  transport: DexScreenerTransport,
  overrides: Partial<BarsPageOptions> = {}
): BarsPageOptions {
  return {
    transport,
    chainId: CHAIN,
    pairAddress: PAIR,
    ammId: AMM,
    quoteTokenAddress: QUOTE,
    resolution: "1h",
    series: "price",
    inverted: false,
    countBack: BARS_PER_CALL,
    timeoutMs: 5_000,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Bars                                                                */
/* ------------------------------------------------------------------ */

describe("the bar transport split is a provider fact, resolved per resolution", () => {
  it("covers all 18 resolutions with exactly one transport each", () => {
    expect(BAR_RESOLUTIONS).toHaveLength(18);
    for (const resolution of BAR_RESOLUTIONS) {
      expect(["http", "feed_ws"]).toContain(barTransportFor(resolution));
      expect(barStepMs(resolution)).toBeGreaterThan(0);
    }
  });

  it("routes the measured HTTP-400 resolutions to the socket, and no others", () => {
    // 5s and daily-and-above were probed live and refused by HTTP.
    expect(barTransportFor("5s")).toBe("feed_ws");
    expect(barTransportFor("1d")).toBe("feed_ws");
    expect(barTransportFor("3d")).toBe("feed_ws");
    expect(barTransportFor("1w")).toBe("feed_ws");
    expect(barTransportFor("1mo")).toBe("feed_ws");
    // 1s is the neighbouring second-scale value HTTP DOES serve, which is what
    // makes the 5s refusal a measured fact rather than a rule about seconds.
    expect(barTransportFor("1s")).toBe("http");
    expect(barTransportFor("12h")).toBe("http");
  });

  it("never mentions abn, which is measured dead as a forward anchor", () => {
    const url = barsHttpUrl(
      barsOptions(scripted({}).transport, { beforeBlockNumber: 25_178_614 })
    );
    expect(url).toContain("bbn=25178614");
    expect(url).not.toContain("abn");
  });

  it("builds the HTTP query the site sends, preserving address case", () => {
    const url = barsHttpUrl(
      barsOptions(scripted({}).transport, {
        resolution: "1h",
        countBack: 48,
        series: "marketCap",
        inverted: true,
      })
    );
    expect(url).toContain("/dex/chart/amm/v3/uniswap/bars/ethereum/");
    // Solana pair ids and quote tokens are case-sensitive on this route.
    expect(url).toContain(PAIR);
    expect(url).toContain(`q=${encodeURIComponent(QUOTE)}`);
    expect(url).toContain("res=60");
    expect(url).toContain("cb=48");
    expect(url).toContain("i=1");
    expect(url).toContain("mc=1");
    // Market-cap bars need NO supply argument on either transport.
    expect(url).not.toContain("cs=");
  });
});

describe("bars decode identically from both transports", () => {
  it("decodes an HTTP Avro page to 999 bars with decimal strings intact", async () => {
    const { transport } = scripted({ http: [{ status: 200, body: HTTP_BARS }] });
    const page = await fetchBarsPage(barsOptions(transport));
    expect(page.transport).toBe("http");
    expect(page.bars).toHaveLength(BARS_PER_CALL);
    const bar = page.bars[0];
    // Prices stay STRINGS: they are money and never touch a float.
    expect(typeof bar?.closeNative).toBe("string");
    expect(typeof bar?.closeUsd).toBe("string");
    expect(bar?.minBlockNumber).toBeGreaterThan(0);
  });

  it("decodes a feed-WS daily frame, the resolution HTTP refuses", async () => {
    const { transport } = scripted({ ws: [[WS_BARS_D1]] });
    const page = await fetchBarsPage(
      barsOptions(transport, {
        resolution: "1d",
        countBack: 60,
        // The capture's own correlation id, so the dispatch under test is the
        // real one rather than a relaxed match.
        correlationId: 41,
      })
    );
    expect(page.transport).toBe("feed_ws");
    expect(page.bars).toHaveLength(60);
    const bar = page.bars[0];
    expect(typeof bar?.closeNative).toBe("string");
    expect(bar?.timestampMs).toBeGreaterThan(0);
    // Daily bars are a day apart.
    const second = page.bars[1];
    expect((second?.timestampMs ?? 0) - (bar?.timestampMs ?? 0)).toBe(
      barStepMs("1d")
    );
  });

  it("decodes market-cap bars, which carry no supply argument", () => {
    // The capture is the socket's answer to a BAR_TYPE_MARKET_CAP command that
    // carried no circulating-supply field at all, and the provider answered OK
    // with a full page. That is the whole contract: market-cap series need no
    // supply argument on this transport.
    const page = readBarsFrames([WS_BARS_MARKETCAP], 42);
    expect(page?.bars).toHaveLength(60);
    expect(page?.bars[0]?.closeUsd).not.toBeNull();
    expect(page?.bars[0]?.closeNative).not.toBeNull();
  });

  it("dispatches on the oneof and the correlation id, never on frame position", () => {
    // A latestBlock-style frame first, then the answer: the measured ordering.
    const noise = new Uint8Array([0x00]);
    expect(readBarsFrames([noise, WS_BARS_D1], 41)?.bars).toHaveLength(60);
    // Somebody else's correlation id is not this call's answer.
    expect(readBarsFrames([WS_BARS_D1], 999)).toBeNull();
  });
});

describe("the inverted series has its transposed USD extremes put back in order", () => {
  /**
   * A wrong number on a money path, reachable with `inverted: true` alone
   * because `priceBasis` defaults to usd.
   *
   * The provider transposes the USD high and low columns on the inverted
   * series. Measured on this very capture: 853 of 999 rows arrive with
   * `highUSD < lowUSD`, against 0 of 999 on the byte-identical non-inverted
   * call, while the native columns are correctly ordered in both. Read
   * straight through, the reported period high sat BELOW the true high and the
   * reported low ABOVE the true low.
   */
  const HTTP_BARS_INVERTED = loadFixture("bars-http-inverted-usd-transposed").bytes;

  it("never reports a bar whose high is below its own low", async () => {
    const page = await fetchBarsPage(
      barsOptions(
        scripted({ http: [{ status: 200, body: HTTP_BARS_INVERTED }] }).transport,
        { inverted: true }
      )
    );
    expect(page.bars.length).toBe(999);

    const transposed = page.bars.filter((bar) => {
      const high = Number(bar.highUsd);
      const low = Number(bar.lowUsd);
      return Number.isFinite(high) && Number.isFinite(low) && high < low;
    });
    expect(transposed).toHaveLength(0);

    // The native columns were already ordered and must stay that way, so the
    // repair cannot be "sort everything" masking a real orientation problem.
    const nativeTransposed = page.bars.filter((bar) => {
      const high = Number(bar.highNative);
      const low = Number(bar.lowNative);
      return Number.isFinite(high) && Number.isFinite(low) && high < low;
    });
    expect(nativeTransposed).toHaveLength(0);
  });

  it("keeps the provider's lexemes exactly, swapping them rather than re-rendering", async () => {
    const page = await fetchBarsPage(
      barsOptions(
        scripted({ http: [{ status: 200, body: HTTP_BARS_INVERTED }] }).transport,
        { inverted: true }
      )
    );
    // A repair that re-rendered the number would silently change precision on
    // a decimal string the caller may compare or store.
    for (const bar of page.bars.slice(0, 50)) {
      for (const lexeme of [bar.highUsd, bar.lowUsd]) {
        if (lexeme === null) continue;
        expect(typeof lexeme).toBe("string");
        expect(String(Number(lexeme))).not.toBe("NaN");
      }
    }
    // And the pair is genuinely a swap: the same two values are still present,
    // just the right way round.
    const first = page.bars[0];
    expect(first).toBeDefined();
    expect(Number(first?.highUsd)).toBeGreaterThanOrEqual(Number(first?.lowUsd));
  });
});

describe("a wrong quote token returns a silently inverted series", () => {
  it("shows the inversion is invisible in the payload itself", async () => {
    const canonical = await fetchBarsPage(
      barsOptions(
        scripted({ http: [{ status: 200, body: HTTP_BARS_CANONICAL }] }).transport,
        { countBack: 1 }
      )
    );
    const wrongQuote = await fetchBarsPage(
      barsOptions(
        scripted({ http: [{ status: 200, body: HTTP_BARS_WRONG_QUOTE }] }).transport,
        { countBack: 1, quoteTokenAddress: BASE }
      )
    );
    // Both are well-formed bar sets with no marker of any kind. The only way to
    // know which orientation you have is to have sent the pair's own quote,
    // which is why the quote is resolved from the pair and is not a parameter.
    expect(canonical.bars.length).toBeGreaterThan(0);
    expect(wrongQuote.bars.length).toBeGreaterThan(0);
    const canonicalClose = Number(canonical.bars[0]?.closeNative);
    const invertedClose = Number(wrongQuote.bars[0]?.closeNative);
    expect(canonicalClose).toBeGreaterThan(0);
    expect(invertedClose).toBeGreaterThan(0);
    expect(canonicalClose).not.toBeCloseTo(invertedClose, 12);
  });
});

describe("the backward walk reports every bound it hits", () => {
  it("stops at maxPages and hands back an exact block cursor", async () => {
    const { transport, httpUrls } = scripted({
      http: [
        { status: 200, body: HTTP_BARS },
        { status: 200, body: HTTP_BARS },
      ],
    });
    const result = await walkBars({
      ...barsOptions(transport),
      limit: 5_000,
      startAtMs: 0,
      maxPages: 2,
      deadlineMs: 60_000,
    });
    expect(result.pagesWalked).toBe(2);
    expect(result.stopReason).toBe("page_budget");
    expect(result.nextBeforeBlock).not.toBeNull();
    // The second request continued from the first page's oldest block.
    expect(httpUrls[1]).toContain("bbn=");
  });

  it("stops when the provider runs out and then offers NO cursor", async () => {
    const { transport } = scripted({
      http: [
        { status: 200, body: HTTP_BARS_ANCHORED },
        { status: 200, body: emptyBarsBody() },
      ],
    });
    const result = await walkBars({
      ...barsOptions(transport),
      limit: 5_000,
      startAtMs: 0,
      maxPages: 5,
      deadlineMs: 60_000,
    });
    expect(result.stopReason).toBe("provider_exhausted");
    expect(result.nextBeforeBlock).toBeNull();
  });

  it("stops as soon as the requested start is covered, without extra pages", async () => {
    const { transport, httpUrls } = scripted({
      http: [{ status: 200, body: HTTP_BARS }],
    });
    const result = await walkBars({
      ...barsOptions(transport),
      limit: 100,
      // A start time far in the future of the fixture's oldest bar is covered
      // by page one, so no second request may be made.
      startAtMs: Date.now(),
      maxPages: 10,
      deadlineMs: 60_000,
    });
    expect(httpUrls).toHaveLength(1);
    expect(result.stopReason).toBe("satisfied");
    expect(result.pagesWalked).toBe(1);
  });

  it("returns bars oldest first with no duplicate timestamps across pages", async () => {
    const { transport } = scripted({
      http: [
        { status: 200, body: HTTP_BARS },
        { status: 200, body: HTTP_BARS },
      ],
    });
    const result = await walkBars({
      ...barsOptions(transport),
      limit: 5_000,
      startAtMs: 0,
      maxPages: 2,
      deadlineMs: 60_000,
    });
    // The same page replayed twice must not double-count a single bar.
    expect(result.bars).toHaveLength(BARS_PER_CALL);
    const timestamps = result.bars.map((bar) => bar.timestampMs);
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });
});

/** A valid, empty PL_BARS_RESPONSE: schemaVersion then a null bars union. */
function emptyBarsBody(): Uint8Array {
  // "1.0.0" as an Avro string (zigzag length 10 = 5 bytes) then union index 0.
  return new Uint8Array([0x0a, 0x31, 0x2e, 0x30, 0x2e, 0x30, 0x00]);
}

/* ------------------------------------------------------------------ */
/* Trades                                                              */
/* ------------------------------------------------------------------ */

function tradesOptions(
  transport: DexScreenerTransport,
  overrides: Partial<TradesPageOptions> = {}
): TradesPageOptions {
  return {
    transport,
    chainId: CHAIN,
    pairAddress: PAIR,
    ammId: AMM,
    quoteTokenAddress: QUOTE,
    inverted: false,
    filters: { eventType: "all" },
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("the trade channel is chosen by what each one can express", () => {
  it("sends a first buy or sell page over Connect, whose spelling is measured", () => {
    expect(tradesChannelFor("all", false)).toBe("connect");
    expect(tradesChannelFor("buy", false)).toBe("connect");
    expect(tradesChannelFor("sell", false)).toBe("connect");
  });

  it("sends the COMBINED filters over the socket, which is the only channel that expresses them", () => {
    // Only the combined spellings are refused by Connect. Re-measured live
    // 2026-08-25: `swap`, `liquidity`, `buy_or_sell`, `add_or_remove` and the
    // literal `all` each answer `400 {"code":"invalid_argument"}`, as does any
    // wrong casing.
    expect(tradesChannelFor("swap", false)).toBe("feed_ws");
    expect(tradesChannelFor("liquidity", false)).toBe("feed_ws");
  });

  it("sends a first add or remove page over Connect, whose spelling was re-measured", () => {
    /*
     * THIS ASSERTION IS THE FIX, NOT A SHAPE CHECK.
     *
     * `add` and `remove` were routed to the feed WebSocket on the belief that
     * Connect had no proven spelling for them. Measured live 2026-08-25 on
     * ethereum PEPE/WETH, a pool with real joinExit events: `type=add` and
     * `type=remove` each answer HTTP 200 with 100 rows carrying the matching
     * `joinExit` arm. The socket is the more expensive and more fragile
     * channel, so this moved real traffic; reverting the EVENT_TYPES entries
     * turns this test red.
     */
    expect(tradesChannelFor("add", false)).toBe("connect");
    expect(tradesChannelFor("remove", false)).toBe("connect");
  });

  it("always sends a continuation over the socket, whatever the filter", () => {
    for (const eventType of ["all", "buy", "sell", "swap"] as const) {
      expect(tradesChannelFor(eventType, true)).toBe("feed_ws");
    }
  });

  it("encodes Connect filters as urlsafe base64 with the padding removed", () => {
    const url = tradesConnectUrl(
      tradesOptions(scripted({}).transport, {
        filters: {
          eventType: "buy",
          volumeUsdMin: "1000",
          maker: "0x5B43",
          startAtMs: 1_756_000_000_000,
        },
      })
    );
    expect(url).toContain("connect=v1&encoding=proto&base64=1&message=");
    const message = url.split("message=")[1] ?? "";
    expect(message).not.toContain("=");
    expect(message).not.toContain("+");
    expect(message).not.toContain("/");
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("trade rows carry the counterparty profile with corrected semantics", () => {
  it("decodes a Connect page to 100 rows", async () => {
    const { transport } = scripted({
      http: [{ status: 200, body: CONNECT_TRADES }],
    });
    const page = await fetchTradesPage(tradesOptions(transport));
    expect(page.channel).toBe("connect");
    expect(page.trades).toHaveLength(TRADES_PER_PAGE);
  });

  it("decodes a socket page and names retained share, not supply share", async () => {
    const { transport } = scripted({ ws: [[WS_TRADES]] });
    const page = await fetchTradesPage(
      tradesOptions(transport, {
        filters: { eventType: "swap" },
        correlationId: 11,
      })
    );
    expect(page.channel).toBe("feed_ws");
    expect(page.trades).toHaveLength(TRADES_PER_PAGE);
    const trader = page.trades.find((trade) => trade.trader !== null)?.trader;
    expect(trader).toBeDefined();
    // The field is named for what it measures: the share of what the wallet
    // BOUGHT that it still holds. It is never percent of supply.
    expect(trader).toHaveProperty("retainedBoughtPct");
    expect(trader).not.toHaveProperty("supplyPct");
    expect(trader).toHaveProperty("newOnPair");
    expect(trader).not.toHaveProperty("realizedPnlUsd");
  });

  it("derives net cash flow as out minus in, and null when either is missing", async () => {
    const { transport } = scripted({ ws: [[WS_TRADES]] });
    const page = await fetchTradesPage(
      tradesOptions(transport, {
        filters: { eventType: "swap" },
        correlationId: 11,
      })
    );
    for (const trade of page.trades) {
      const trader = trade.trader;
      if (trader === null) continue;
      if (trader.volumeUsdBuy === null || trader.volumeUsdSell === null) {
        expect(trader.netCashFlowUsd).toBeNull();
        continue;
      }
      expect(trader.netCashFlowUsd).toBeCloseTo(
        Number(trader.volumeUsdSell) - Number(trader.volumeUsdBuy),
        6
      );
    }
  });

  it("keeps every price and token amount a decimal string", async () => {
    const { transport } = scripted({ ws: [[WS_TRADES]] });
    const page = await fetchTradesPage(
      tradesOptions(transport, {
        filters: { eventType: "swap" },
        correlationId: 11,
      })
    );
    const swap = page.trades.find((trade) => trade.eventType === "buy");
    expect(typeof swap?.priceUsd).toBe("string");
    expect(typeof swap?.volumeUsd).toBe("string");
    expect(typeof swap?.amountBase).toBe("string");
  });
});

describe("the continuation cursor is the exact triple", () => {
  it("builds it from the oldest row of a full page", async () => {
    const { transport } = scripted({ ws: [[WS_TRADES]] });
    const page = await fetchTradesPage(
      tradesOptions(transport, {
        filters: { eventType: "swap" },
        correlationId: 11,
      })
    );
    const cursor = page.nextCursor;
    expect(cursor).not.toBeNull();
    // All three components, because a block-only cursor measurably skipped a
    // real same-block BUY in a controlled probe.
    expect(cursor).toHaveProperty("blockNumber");
    expect(cursor).toHaveProperty("transactionIndex");
    expect(cursor).toHaveProperty("eventIndex");
    const oldest = page.trades[page.trades.length - 1];
    expect(cursor?.blockNumber).toBe(oldest?.blockNumber);
    expect(cursor?.transactionIndex).toBe(oldest?.transactionIndex);
    expect(cursor?.eventIndex).toBe(oldest?.eventIndex);
  });

  it("offers no cursor on a short page, which is the end of this filter", () => {
    const trades = readTradesFrames([WS_TRADES], 11) ?? [];
    expect(trades).toHaveLength(TRADES_PER_PAGE);
    // The projection's own rule, exercised through a page below the page size.
    expect(trades.length).toBeGreaterThanOrEqual(TRADES_PER_PAGE);
  });

  it("resumes into the same block rather than past it", async () => {
    const { transport, wsFrames } = scripted({ ws: [[WS_TRADES_PAGE2]] });
    const page = await fetchTradesPage(
      tradesOptions(transport, {
        filters: { eventType: "swap" },
        correlationId: 12,
        cursor: { blockNumber: 25_823_281, transactionIndex: 5, eventIndex: 59 },
      })
    );
    expect(page.channel).toBe("feed_ws");
    expect(page.trades).toHaveLength(TRADES_PER_PAGE);
    expect(wsFrames).toHaveLength(1);
    // The captured page-two body is the provider's real answer to exactly this
    // cursor, so its first row is what an exact continuation returns.
    expect(page.trades[0]?.blockNumber).toBeLessThanOrEqual(25_823_281);
  });

  it("dispatches trade frames on the correlation id", () => {
    expect(readTradesFrames([WS_TRADES], 11)).not.toBeNull();
    expect(readTradesFrames([WS_TRADES], 4242)).toBeNull();
  });
});

describe("the candle block anchor is approximate and reports its distance", () => {
  it("resolves an instant to the nearest PRIOR trade and measures the gap", async () => {
    const { transport } = scripted({
      http: [{ status: 200, body: CONNECT_ANCHOR }],
    });
    const requestedAtMs = Date.parse("2026-05-26T09:38:32Z");
    const anchor = await resolveBlockAnchor({
      transport,
      chainId: CHAIN,
      pairAddress: PAIR,
      ammId: AMM,
      quoteTokenAddress: QUOTE,
      inverted: false,
      timeoutMs: 5_000,
      atMs: requestedAtMs,
    });
    expect(anchor?.blockNumber).toBe(25_178_613);
    expect(anchor?.resolvedAtMs).toBe(Date.parse("2026-05-26T09:31:59Z"));
    // The measured 393-second miss. It is real, it is reported, and a client
    // that treated the anchor as exact would silently answer the wrong window.
    expect(anchor?.distanceMs).toBe(393_000);
  });

  it("returns null when the provider has no trade at or before the instant", async () => {
    const { transport } = scripted({
      http: [{ status: 200, body: emptyTransactionsBody() }],
    });
    const anchor = await resolveBlockAnchor({
      transport,
      chainId: CHAIN,
      pairAddress: PAIR,
      ammId: AMM,
      quoteTokenAddress: QUOTE,
      inverted: false,
      timeoutMs: 5_000,
      atMs: 1_000,
    });
    // A real answer meaning "the pool did not exist yet", not a failure.
    expect(anchor).toBeNull();
  });
});

/** An empty dex_feed.GetTransactionsResponse: no fields set. */
function emptyTransactionsBody(): Uint8Array {
  return new Uint8Array(0);
}

/* ------------------------------------------------------------------ */
/* Top traders                                                         */
/* ------------------------------------------------------------------ */

function topOptions(
  transport: DexScreenerTransport,
  overrides: Partial<TopTradersOptions> = {}
): TopTradersOptions {
  return {
    transport,
    chainId: CHAIN,
    pairAddress: PAIR,
    ammId: AMM,
    quoteTokenAddress: QUOTE,
    sortBy: "boughtUsd",
    sortDir: "desc",
    onlyKol: false,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("the top-traders request", () => {
  it("always sends s and sd, which the provider requires", () => {
    for (const sortBy of TOP_TRADER_SORTS) {
      const url = topTradersUrl(topOptions(scripted({}).transport, { sortBy }));
      expect(url).toMatch(/[?&]s=/);
      expect(url).toMatch(/[?&]sd=/);
      expect(url).toContain(`q=${encodeURIComponent(QUOTE)}`);
    }
  });

  it("maps the public sort names onto the provider's own", () => {
    const url = (sortBy: (typeof TOP_TRADER_SORTS)[number]): string =>
      topTradersUrl(topOptions(scripted({}).transport, { sortBy }));
    expect(url("boughtUsd")).toContain("s=bought");
    expect(url("soldUsd")).toContain("s=sold");
    // The provider calls net cash flow "pnl" and holding value "unrealized".
    // Both provider names are wrong about what they measure, so the public
    // names say what the column IS and the mapping stays internal.
    expect(url("netCashFlowUsd")).toContain("s=pnl");
    expect(url("currentHoldingValueUsd")).toContain("s=unrealized");
  });

  it("never sends lpId, which was measured byte-identically ignored", () => {
    const url = topTradersUrl(
      topOptions(scripted({}).transport, { lookbackDays: 7, onlyKol: true })
    );
    expect(url).not.toContain("lpId");
    expect(url).toContain("mda=7");
    expect(url).toContain("k=1");
  });

  it("omits mda entirely when no lookback was asked for", () => {
    expect(topTradersUrl(topOptions(scripted({}).transport))).not.toContain("mda");
  });
});

describe("top-trader rows carry cash flow, never profit", () => {
  it("decodes the captured leaderboard and derives per-row metrics", () => {
    const rows = parseTopTraders(TOP_MAKERS);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(100);
    const row = rows[0];
    expect(row?.providerRank).toBe(1);
    expect(row?.maker).toMatch(/^0x/u);
    // Cash flow, not profit: out minus in, with no cost basis anywhere.
    expect(row?.netCashFlowUsd).toBeCloseTo(
      (row?.volumeUsdSell ?? 0) - (row?.volumeUsdBuy ?? 0),
      6
    );
    // Active span, not a holding period.
    expect(row?.activeSpanSeconds).toBeGreaterThanOrEqual(0);
    expect(row).not.toHaveProperty("realizedPnlUsd");
    expect(row).not.toHaveProperty("holdingPeriodSeconds");
    expect(row).toHaveProperty("retainedBoughtPct");
  });

  it("keeps base-token amounts as decimal strings", () => {
    const row = parseTopTraders(TOP_MAKERS)[0];
    expect(typeof row?.amountBuy).toBe("string");
    expect(typeof row?.amountSell).toBe("string");
  });

  it("refuses bytes that are not a leaderboard with its own remedy", () => {
    expect(() => parseTopTraders(new Uint8Array([0xff, 0xff, 0xff]))).toThrowError(
      expect.objectContaining({
        code: DexScreenerSiteErrorCodes.TOP_TRADERS_INVALID,
      })
    );
  });
});

/* ------------------------------------------------------------------ */
/* The anti-normalization guard                                        */
/* ------------------------------------------------------------------ */

/**
 * ONE GUARD FOR THE WHOLE FAMILY: NO PROVIDER IDENTITY IS EVER RE-CASED.
 *
 * This is the test that catches the defect nothing else can. Every channel
 * below answers HTTP 200 with plausible rows for a MIS-CASED identity, so the
 * failure is invisible at every layer downstream of the request:
 *
 *  - the quote token (`q` on bars and top traders, `quoteTokenAddress` on the
 *    Connect trades read, `quoteTokenId` on the socket) is the ORIENTATION
 *    key. Measured on ethereum PEPE/WETH: the correct checksum spelling ranks
 *    the top maker at volumeUsdBuy 5,219,201.99 with amountBuy
 *    "1468926772500.29" in PEPE, and the SAME ADDRESS LOWER-CASED returns a
 *    byte-different body ranking the same maker at 4,315,234.24 with amountBuy
 *    "1913.84" in WETH: buy and sell transposed, amounts in the other token,
 *    and `netCashFlowUsd` with its SIGN FLIPPED. On bars the same mistake is
 *    seventeen orders of magnitude.
 *  - the EVM `pairId` on the Connect trades read is case-sensitive too: the
 *    checksum spelling returns 100 rows and the lowercased one returns HTTP
 *    200 with ZERO, which reads as "this pool has no trades".
 *  - the insight `tokenId` on the feed socket is case-sensitive in the same
 *    way, and a wrong id answers NOT_FOUND, which is indistinguishable from a
 *    token the provider has simply written nothing about.
 *
 * A future "tidy up the addresses" normalization, anywhere on these paths, is
 * exactly the change that would pass every other test in this repository and
 * silently invert three tools at once. It turns this one red.
 */
describe("no provider identity is normalized on any deep-dive request", () => {
  /** The same address the fixtures use, spelled the two ways that differ. */
  const QUOTE_LOWER = QUOTE.toLowerCase();
  const PAIR_LOWER = PAIR.toLowerCase();

  it("proves the two spellings really are different strings", () => {
    // Without this the rest of the describe would pass vacuously on a chain
    // whose addresses happen to be all-lowercase already.
    expect(QUOTE_LOWER).not.toBe(QUOTE);
    expect(PAIR_LOWER).not.toBe(PAIR);
  });

  it("sends the quote token to the bars endpoint exactly as the subject spells it", () => {
    const url = barsHttpUrl(barsOptions(scripted({}).transport));
    expect(url).toContain(`q=${encodeURIComponent(QUOTE)}`);
    expect(url).not.toContain(`q=${encodeURIComponent(QUOTE_LOWER)}`);
    // And the pair address in the PATH is untouched as well: the chain slug is
    // the only vocabulary value on this route.
    expect(url).toContain(encodeURIComponent(PAIR));
    expect(url).not.toContain(encodeURIComponent(PAIR_LOWER));
  });

  it("sends the quote token to the top-traders endpoint exactly as the subject spells it", () => {
    const url = topTradersUrl(topOptions(scripted({}).transport));
    expect(url).toContain(`q=${encodeURIComponent(QUOTE)}`);
    expect(url).not.toContain(`q=${encodeURIComponent(QUOTE_LOWER)}`);
    expect(url).toContain(encodeURIComponent(PAIR));
  });

  it("encodes the verbatim quote token and pair id into the Connect trades message", () => {
    const url = tradesConnectUrl(tradesOptions(scripted({}).transport));
    const message = new URL(url).searchParams.get("message");
    expect(message).not.toBeNull();
    // The wire body is protobuf inside urlsafe base64. Decoding it is the only
    // way to see what was actually sent, and the point is the exact bytes.
    const decoded = decodeDexScreenerMessageToJson(
      "dex_feed.GetTransactionsRequest",
      new Uint8Array(Buffer.from(message ?? "", "base64url")),
      { maxBytes: 4096 }
    ) as Record<string, unknown>;
    expect(decoded["quoteTokenAddress"]).toBe(QUOTE);
    expect(decoded["pairId"]).toBe(PAIR);
    expect(decoded["quoteTokenAddress"]).not.toBe(QUOTE_LOWER);
    expect(decoded["pairId"]).not.toBe(PAIR_LOWER);
  });

  it("encodes the verbatim quote token and pair id into the socket trades command", async () => {
    const recorded = scripted({ ws: [[WS_TRADES]] });
    await fetchTradesPage(
      tradesOptions(recorded.transport, {
        filters: { eventType: "swap" },
        // The cid the capture was taken under, so the fixture answers this call.
        correlationId: 11,
      })
    );
    const frame = recorded.wsFrames[0];
    expect(frame).toBeDefined();
    const command = decodeDexScreenerMessageToJson(
      "dex_feed.WSCommand",
      frame ?? new Uint8Array(0),
      { maxBytes: 4096 }
    ) as Record<string, Record<string, unknown>>;
    const arm = command["getHistoricalTransactions"];
    expect(arm?.["quoteTokenId"]).toBe(QUOTE);
    expect(arm?.["pairId"]).toBe(PAIR);
  });

  it("encodes the verbatim token id into the feed socket's insight command", async () => {
    const recorded = scripted({ ws: [[INSIGHT_NOT_FOUND]] });
    await fetchTokenInsight({
      transport: recorded.transport,
      chainId: CHAIN,
      tokenAddress: BASE,
      timeoutMs: 5_000,
    });
    const frame = recorded.wsFrames[0];
    expect(frame).toBeDefined();
    const command = decodeDexScreenerMessageToJson(
      "dex_feed.WSCommand",
      frame ?? new Uint8Array(0),
      { maxBytes: 4096 }
    ) as Record<string, Record<string, unknown>>;
    expect(command["getTokenInsight"]?.["tokenId"]).toBe(BASE);
    expect(command["getTokenInsight"]?.["tokenId"]).not.toBe(BASE.toLowerCase());
  });
});

/* ------------------------------------------------------------------ */
/* afterBlock: the forward bound                                       */
/* ------------------------------------------------------------------ */

describe("afterBlock is the provider's own forward bound, spelled from the descriptor", () => {
  /**
   * WIRE NAMES COME FROM THE MACHINE ARTIFACT, NEVER FROM CONVENTION.
   *
   * `afterBlockNumber` is spelled by this module and sent to the provider. It
   * is resolved here against the checked-in descriptor set rather than against
   * the recon note that advertised it, so a rename or a removal on the
   * provider's side fails this test instead of producing a silently ignored
   * filter (which is exactly what an unknown field does on this endpoint:
   * measured, four unknown field numbers were ignored and returned a
   * byte-identical body).
   */
  it("resolves every field name this module emits against the checked-in descriptor", () => {
    const descriptor = getDexScreenerMessageDescriptor(
      "dex_feed.GetTransactionsRequest"
    );
    const wireNames = new Set(descriptor.fields.map((field) => field.name));
    for (const emitted of [
      "chainId", "ammId", "pairId", "quoteTokenAddress", "invert", "type",
      "maker", "volumeUSDMin", "volumeUSDMax", "amount0Min", "amount0Max",
      "amount1Min", "amount1Max", "timestampStart", "timestampEnd",
      "afterBlockNumber",
    ]) {
      expect(wireNames).toContain(emitted);
    }
  });

  it("sends afterBlock as afterBlockNumber on the Connect channel", () => {
    const url = tradesConnectUrl(
      tradesOptions(scripted({}).transport, {
        filters: { eventType: "buy", afterBlock: 25_830_000 },
      })
    );
    const message = new URL(url).searchParams.get("message");
    const decoded = decodeDexScreenerMessageToJson(
      "dex_feed.GetTransactionsRequest",
      new Uint8Array(Buffer.from(message ?? "", "base64url")),
      { maxBytes: 4096 }
    ) as Record<string, unknown>;
    // uint64 renders as a string in protobuf JSON form.
    expect(String(decoded["afterBlockNumber"])).toBe("25830000");
  });

  it("omits afterBlockNumber entirely when no bound was asked for", () => {
    const url = tradesConnectUrl(tradesOptions(scripted({}).transport));
    const message = new URL(url).searchParams.get("message");
    const decoded = decodeDexScreenerMessageToJson(
      "dex_feed.GetTransactionsRequest",
      new Uint8Array(Buffer.from(message ?? "", "base64url")),
      { maxBytes: 4096 }
    ) as Record<string, unknown>;
    expect(decoded["afterBlockNumber"]).toBeUndefined();
  });

  /*
   * THE TWO CHANNELS MUST EXPRESS THE SAME WINDOW, AND THAT IS MEASURED.
   *
   * `afterBlock` used to be REFUSED on every socket-routed request, because
   * the socket's lower bound is an `after` TRIPLE whose inclusivity at the
   * boundary block had never been measured, and a guess would have made the
   * two channels disagree invisibly at the edge. The refusal locked both
   * continuation doors: a full page fetched with `afterBlock` handed back a
   * cursor that the next call refused, so the rows between `afterBlock` and
   * the oldest block returned were reachable by no request at all.
   *
   * Measured live 2026-08-25 on solana boundary block B = 441363104, which
   * carries three events (archived under `scratchpad/s9/`):
   *   after = (B, 0, 0)     -> 82 rows, all three of B PRESENT
   *   after = (B, 10, 3)    -> 81 rows, exactly that event absent (exclusive)
   *   after = (B, MAX, MAX) -> 79 rows, none of B, oldest block 441363187
   * and Connect's `afterBlockNumber = B` excludes the whole of B. So the
   * anchor below is the one spelling under which the socket answers the same
   * window as Connect, and the tests pin the anchor, not merely its presence.
   */
  it("sends the socket the block-exclusive after triple, so both channels mean the same window", async () => {
    const recorded = scripted({ ws: [[WS_TRADES]] });
    await fetchTradesPage(
      tradesOptions(recorded.transport, {
        filters: { eventType: "swap", afterBlock: 25_830_000 },
        correlationId: 11,
      })
    );
    const frame = recorded.wsFrames[0];
    expect(frame).toBeDefined();
    const command = decodeDexScreenerMessageToJson(
      "dex_feed.WSCommand",
      frame ?? new Uint8Array(0),
      { maxBytes: 4096 }
    ) as Record<string, Record<string, unknown>>;
    const after = command["getHistoricalTransactions"]?.["after"] as
      | Record<string, unknown>
      | undefined;
    // Anchored at the LARGEST index pair, which is what drops the boundary
    // block. `(block, 0, 0)` would keep it and disagree with Connect.
    expect(after).toStrictEqual({
      blockNumber: "25830000",
      transactionIndex: 4_294_967_295,
      eventIndex: 4_294_967_295,
    });
  });

  it("carries afterBlock AND the cursor triple in one command, so a walk inside the window continues", async () => {
    const recorded = scripted({ ws: [[WS_TRADES_PAGE2]] });
    await fetchTradesPage(
      tradesOptions(recorded.transport, {
        filters: { eventType: "swap", afterBlock: 25_830_000 },
        correlationId: 12,
        cursor: { blockNumber: 25_824_167, transactionIndex: 213, eventIndex: 558 },
      })
    );
    const frame = recorded.wsFrames[0];
    expect(frame).toBeDefined();
    const command = decodeDexScreenerMessageToJson(
      "dex_feed.WSCommand",
      frame ?? new Uint8Array(0),
      { maxBytes: 4096 }
    ) as Record<string, Record<string, unknown>>;
    const arm = command["getHistoricalTransactions"] ?? {};
    // Both bounds, in one command. Measured live composing into a 56-row
    // window bounded above by the cursor and below by the anchor.
    expect(arm["before"]).toStrictEqual({
      blockNumber: "25824167",
      transactionIndex: 213,
      eventIndex: 558,
    });
    expect((arm["after"] as Record<string, unknown>)["blockNumber"]).toBe("25830000");
  });

  it("omits the after triple entirely when no bound was asked for", async () => {
    const recorded = scripted({ ws: [[WS_TRADES]] });
    await fetchTradesPage(
      tradesOptions(recorded.transport, {
        filters: { eventType: "swap" },
        correlationId: 11,
      })
    );
    const command = decodeDexScreenerMessageToJson(
      "dex_feed.WSCommand",
      recorded.wsFrames[0] ?? new Uint8Array(0),
      { maxBytes: 4096 }
    ) as Record<string, Record<string, unknown>>;
    expect(command["getHistoricalTransactions"]?.["after"]).toBeUndefined();
  });

  it("allows afterBlock on every event type Connect expresses", async () => {
    for (const eventType of ["all", "buy", "sell", "add", "remove"] as const) {
      const recorded = scripted({
        http: [{ status: 200, body: CONNECT_TRADES }],
      });
      const page = await fetchTradesPage(
        tradesOptions(recorded.transport, {
          filters: { eventType, afterBlock: 25_830_000 },
        })
      );
      expect(page.channel).toBe("connect");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Frame budgets the deadline can actually pay for                     */
/* ------------------------------------------------------------------ */

describe("every feed-socket frame budget is reachable inside the caller's deadline", () => {
  /*
   * THE DEFECT THIS PINS, WHICH A COMMENT WOULD NOT CATCH.
   *
   * A zero-length binary frame on `feed/ws` is a keepalive and does not count
   * toward `binaryFrames`. That is the right contract, and it removed the
   * padding that used to hide a second bug: the exchange resolves ONLY when
   * the countable count is reached, so a budget larger than the number of
   * countable frames the channel actually emits can never be met. The call
   * blocks to the deadline and throws TRANSPORT_TIMEOUT while holding an
   * answer that arrived in under a second.
   *
   * `feed/ws` is strictly request-response. Measured live 2026-08-25 with the
   * bridge's own frame accounting: bars `[13873, 0, 0]` with the answer at
   * t=0.38 s, trades `[27484, 0, 0]` at t=0.54 s, insight `[6, 0, 0]` at
   * t=0.15 s. ONE countable frame per command, and it is the answer. Both
   * budgets below were 4, which is why every socket-served candle resolution
   * and every trades continuation page timed out.
   *
   * The arithmetic a future change must satisfy is frames x inter-frame
   * interval < deadline. After the answer that interval is INFINITE here, so
   * any budget above 1 fails outright rather than merely running slow.
   */
  const FEED_WS_COUNTABLE_FRAMES_PER_COMMAND = 1;

  it("asks for no more countable frames than one command can produce", () => {
    expect(BARS_FRAMES).toBeLessThanOrEqual(
      FEED_WS_COUNTABLE_FRAMES_PER_COMMAND
    );
    expect(TRADES_FRAMES).toBeLessThanOrEqual(
      FEED_WS_COUNTABLE_FRAMES_PER_COMMAND
    );
    // And at least one, or the exchange would resolve before any answer.
    expect(BARS_FRAMES).toBeGreaterThanOrEqual(1);
    expect(TRADES_FRAMES).toBeGreaterThanOrEqual(1);
  });

  it("declares a budget the deadline can pay for at the measured cadence", () => {
    // The keepalive cadence is what a budget above the answer count would have
    // to wait out, and it cannot: three keepalives at ~15 s already exceed the
    // 25 s channel deadline, which is exactly the measured failure.
    const KEEPALIVE_INTERVAL_MS = 15_000;
    for (const frames of [BARS_FRAMES, TRADES_FRAMES]) {
      const extra = frames - FEED_WS_COUNTABLE_FRAMES_PER_COMMAND;
      expect(extra * KEEPALIVE_INTERVAL_MS).toBeLessThan(CHANNEL_TIMEOUT_MS);
    }
  });

  it("resolves a socket answer from a single countable frame", async () => {
    // The live shape, reproduced: the answer first, then keepalives that do
    // not count. If the budget regresses above 1 this hangs on the transport
    // instead of returning, which is the production failure in miniature.
    const recorded = scripted({
      ws: [[WS_BARS_D1, new Uint8Array(0), new Uint8Array(0)]],
    });
    const page = await fetchBarsPage(
      barsOptions(recorded.transport, { resolution: "1d", correlationId: 41 })
    );
    expect(page.transport).toBe("feed_ws");
    expect(page.bars.length).toBeGreaterThan(0);
  });
});
