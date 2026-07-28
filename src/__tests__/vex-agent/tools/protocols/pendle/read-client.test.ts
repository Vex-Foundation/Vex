/**
 * `PendleReadClient` — request construction, honest pagination, and the error
 * contract the read lane owes its callers.
 *
 * The two behaviours worth protecting here are the ones a green shape test
 * would miss: a catalogue walk that ends without seeing everything must SAY so
 * rather than return a prefix, and a provider that ANSWERED must be
 * distinguishable from a provider we could not reach — `httpStatus` present
 * versus absent, `retryable` true versus false. Reporting a definitive 400 as a
 * retriable transport failure is the exact defect rules/90 records.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes, VexError } from "../../../../../errors.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockFetch = vi.fn();
const mockReadJson = vi.fn();
vi.mock("@utils/http.js", () => ({
  fetchWithTimeout: (...a: unknown[]) => mockFetch(...a),
  readJson: (...a: unknown[]) => mockReadJson(...a),
}));

const { PendleReadClient } = await import("@tools/pendle/read/client.js");
const { PendleThrottle } = await import("@tools/pendle/throttle.js");
const {
  PENDLE_ASSET_OHLCV,
  PENDLE_MARKETS_ACTIVE_PAGE,
  PENDLE_MERKLE_REWARDS,
  PENDLE_ORDERBOOK,
} = await import("./read-surface-fixtures.js");

const BASE_URL = "https://api.example/core/";
const ACTIVE_MARKET = "0x34280882267ffa6383b363e278b027be083bbe3b";
const WALLET = "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e";

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get: () => null };
  __json: unknown;
}

function okResponse(json: unknown): FakeResponse {
  return { ok: true, status: 200, headers: { get: () => null }, __json: json };
}

function errorResponse(status: number): FakeResponse {
  return { ok: false, status, headers: { get: () => null }, __json: { message: "hostile upstream text", statusCode: status } };
}

/**
 * A test throttle: no CU budget in the way, no cache, and no sleeping. The read
 * lane's real bucket is deliberately tiny (see the client's module header), so a
 * test using it would block on refills rather than test anything.
 */
function testThrottle(): InstanceType<typeof PendleThrottle> {
  return new PendleThrottle({ cuPerMinute: 100_000, deps: { sleep: () => Promise.resolve() } });
}

function client(): InstanceType<typeof PendleReadClient> {
  return new PendleReadClient(BASE_URL, testThrottle());
}

/** Serve a body for every request; record the URLs. */
function serve(body: unknown): void {
  mockReadJson.mockImplementation((r: FakeResponse) => Promise.resolve(r.__json));
  mockFetch.mockImplementation(() => Promise.resolve(okResponse(body)));
}

function requestedUrls(): string[] {
  return mockFetch.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => vi.clearAllMocks());

describe("PendleReadClient request construction", () => {
  it("builds the documented /v2/markets/all query, with the DOTTED sort key", async () => {
    serve(PENDLE_MARKETS_ACTIVE_PAGE);

    await client().getMarketPage({ chainId: 1, isActive: false, sortBy: "details.liquidity", skip: 20, limit: 25 });

    const url = new URL(requestedUrls()[0]!);
    expect(url.pathname).toBe("/core/v2/markets/all");
    expect(url.searchParams.get("chainId")).toBe("1");
    expect(url.searchParams.get("isActive")).toBe("false");
    expect(url.searchParams.get("skip")).toBe("20");
    expect(url.searchParams.get("limit")).toBe("25");
    // Bare `liquidity:-1` is ACCEPTED by the provider and silently does not sort.
    expect(url.searchParams.get("order_by")).toBe("details.liquidity:-1");
  });

  it("clamps the page size to the provider's ceiling of 100", async () => {
    serve(PENDLE_MARKETS_ACTIVE_PAGE);

    await client().getMarketPage({ chainId: 1, limit: 500 });

    expect(new URL(requestedUrls()[0]!).searchParams.get("limit")).toBe("100");
  });

  it("omits isActive entirely when it is not specified, so both maturities are served", async () => {
    serve(PENDLE_MARKETS_ACTIVE_PAGE);

    await client().getMarketPage({ chainId: 1 });

    expect(new URL(requestedUrls()[0]!).searchParams.has("isActive")).toBe(false);
  });

  it("omits chainId entirely when it is not specified — the CROSS-CHAIN mode", async () => {
    // The whole point of /v2/markets/all over the per-chain endpoint: one 2-CU
    // call returns every chain, against 11 sequential calls for the same view.
    serve(PENDLE_MARKETS_ACTIVE_PAGE);

    await client().getMarketPage({ isActive: true });

    const url = new URL(requestedUrls()[0]!);
    expect(url.searchParams.has("chainId")).toBe(false);
    expect(url.searchParams.get("isActive")).toBe("true");
  });

  it("builds the per-market detail paths", async () => {
    serve({ tokensMintSy: [], tokensRedeemSy: [], tokensIn: [], tokensOut: [] });
    await client().getMarketTokens(1, ACTIVE_MARKET);
    expect(new URL(requestedUrls()[0]!).pathname).toBe(`/core/v1/sdk/1/markets/${ACTIVE_MARKET}/tokens`);

    vi.clearAllMocks();
    serve({ underlyingToken: null });
    await client().getSwappingPrices(1, ACTIVE_MARKET);
    expect(new URL(requestedUrls()[0]!).pathname).toBe(`/core/v1/sdk/1/markets/${ACTIVE_MARKET}/swapping-prices`);
  });

  it("sends the history window under the provider's own parameter names", async () => {
    serve({ total: 0, results: [] });

    await client().getMarketHistory(1, ACTIVE_MARKET, {
      timeFrame: "day",
      fields: ["impliedApy", "tvl"],
      timestampStart: "2026-07-20T00:00:00.000Z",
      timestampEnd: "2026-07-27T00:00:00.000Z",
    });

    const url = new URL(requestedUrls()[0]!);
    expect(url.pathname).toBe(`/core/v3/1/markets/${ACTIVE_MARKET}/historical-data`);
    expect(url.searchParams.get("time_frame")).toBe("day");
    expect(url.searchParams.get("fields")).toBe("impliedApy,tvl");
    expect(url.searchParams.get("timestamp_start")).toBe("2026-07-20T00:00:00.000Z");
    expect(url.searchParams.get("timestamp_end")).toBe("2026-07-27T00:00:00.000Z");
  });

  it("sends the candle window as ISO bounds — a seconds bound is a live 400", async () => {
    // Live-verified 2026-07-27 (probe-scout): `timestamp_start=1753000000` →
    // 400 "timestamp_start must be a Date instance", even though the RESPONSE
    // rows carry unix seconds. The query contract is ISO, like historical-data.
    serve(PENDLE_ASSET_OHLCV);

    await client().getAssetCandles(1, ACTIVE_MARKET, {
      timeFrame: "day",
      timestampStart: "2026-07-20T00:00:00.000Z",
      timestampEnd: "2026-07-27T00:00:00.000Z",
    });

    const url = new URL(requestedUrls()[0]!);
    expect(url.pathname).toBe(`/core/v4/1/prices/${ACTIVE_MARKET}/ohlcv`);
    expect(url.searchParams.get("time_frame")).toBe("day");
    expect(url.searchParams.get("timestamp_start")).toBe("2026-07-20T00:00:00.000Z");
    expect(url.searchParams.get("timestamp_end")).toBe("2026-07-27T00:00:00.000Z");
  });

  it("sends the asset-price filters, including the type enum", async () => {
    serve({ prices: { "1-0x34280882267ffa6383b363e278b027be083bbe3b": 1 }, total: 1, skip: 0 });

    await client().getAssetPrices({ chainId: 1, types: ["PT", "YT"] });

    const url = new URL(requestedUrls()[0]!);
    expect(url.pathname).toBe("/core/v1/prices/assets");
    expect(url.searchParams.get("type")).toBe("PT,YT");
  });

  it("sends the order-book market and precision, and includeAmm only when asked", async () => {
    serve(PENDLE_ORDERBOOK);

    await client().getOrderbook(1, ACTIVE_MARKET, { precisionDecimal: 2 });
    let url = new URL(requestedUrls()[0]!);
    expect(url.pathname).toBe("/core/v2/limit-orders/book/1");
    expect(url.searchParams.get("precisionDecimal")).toBe("2");
    expect(url.searchParams.has("includeAmm")).toBe(false);

    vi.clearAllMocks();
    serve(PENDLE_ORDERBOOK);
    await client().getOrderbook(1, ACTIVE_MARKET, { precisionDecimal: 0, includeAmm: true });
    url = new URL(requestedUrls()[0]!);
    expect(url.searchParams.get("includeAmm")).toBe("true");
  });

  it("reads merkle rewards for the given wallet", async () => {
    serve(PENDLE_MERKLE_REWARDS);

    await client().getMerkleRewards(WALLET);

    expect(new URL(requestedUrls()[0]!).pathname).toBe(`/core/v1/dashboard/merkle-rewards/${WALLET}`);
  });
});

describe("PendleReadClient input guards", () => {
  it("refuses a non-address before any network call — a path segment is an unsafe sink", async () => {
    serve(PENDLE_ORDERBOOK);
    const read = client();

    await expect(read.getMarketTokens(1, "../../v3/sdk/1/convert")).rejects.toMatchObject({
      code: ErrorCodes.INVALID_ADDRESS,
    });
    await expect(read.getMerkleRewards("0x1234")).rejects.toMatchObject({ code: ErrorCodes.INVALID_ADDRESS });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses a non-positive chain id", async () => {
    serve(PENDLE_MARKETS_ACTIVE_PAGE);
    await expect(client().getMarketPage({ chainId: 0 })).rejects.toMatchObject({ code: ErrorCodes.CHAIN_MISMATCH });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range order-book precision", async () => {
    serve(PENDLE_ORDERBOOK);
    await expect(client().getOrderbook(1, ACTIVE_MARKET, { precisionDecimal: 4 })).rejects.toMatchObject({
      code: ErrorCodes.AGENT_VALIDATION_ERROR,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses a history request with no fields", async () => {
    serve({ total: 0, results: [] });
    await expect(
      client().getMarketHistory(1, ACTIVE_MARKET, { timeFrame: "day", fields: [] }),
    ).rejects.toMatchObject({ code: ErrorCodes.AGENT_VALIDATION_ERROR });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("PendleReadClient.listMarkets pagination", () => {
  /** Serve `total` synthetic rows in pages of `pageSize`. */
  function servePagedCatalog(total: number, pageSize: number): void {
    mockReadJson.mockImplementation((r: FakeResponse) => Promise.resolve(r.__json));
    mockFetch.mockImplementation((url: string) => {
      const skip = Number(new URL(String(url)).searchParams.get("skip") ?? "0");
      const limit = Number(new URL(String(url)).searchParams.get("limit") ?? "100");
      const count = Math.max(0, Math.min(limit, total - skip));
      const results = Array.from({ length: count }, (_v, i) => ({
        chainId: 1,
        address: `0x${String(skip + i).padStart(40, "0")}`,
        details: {},
      }));
      return Promise.resolve(okResponse({ total, limit, skip, results }));
    });
  }

  it("walks every page and reports the walk as COMPLETE", async () => {
    servePagedCatalog(250, 100);

    const catalog = await client().listMarkets({ chainId: 1 });

    expect(catalog.markets).toHaveLength(250);
    expect(catalog.total).toBe(250);
    expect(catalog.complete).toBe(true);
    expect(catalog.pagesFetched).toBe(3);
  });

  it("stops at the page budget and reports the walk as INCOMPLETE — never a silent prefix", async () => {
    servePagedCatalog(1000, 100);

    const catalog = await client().listMarkets({ chainId: 1 }, 2);

    expect(catalog.markets).toHaveLength(200);
    expect(catalog.total).toBe(1000);
    expect(catalog.complete).toBe(false);
    expect(catalog.pagesFetched).toBe(2);
  });

  it("stops on an empty page instead of looping when `total` overstates the rows", async () => {
    mockReadJson.mockImplementation((r: FakeResponse) => Promise.resolve(r.__json));
    mockFetch.mockImplementation(() => Promise.resolve(okResponse({ total: 500, limit: 100, skip: 0, results: [] })));

    const catalog = await client().listMarkets({ chainId: 1 }, 12);

    expect(catalog.markets).toEqual([]);
    expect(catalog.complete).toBe(false);
    expect(catalog.pagesFetched).toBe(1);
  });

  it("advances `skip` by the page size, from the provider's own echoed offset", async () => {
    servePagedCatalog(150, 100);

    await client().listMarkets({ chainId: 1 });

    const skips = requestedUrls().map((u) => new URL(u).searchParams.get("skip"));
    expect(skips).toEqual(["0", "100"]);
  });

  it("reports COMPLETE from a caller-supplied starting offset", async () => {
    // Completeness is the provider's arithmetic (`skip + limit >= total`), not
    // "how many rows did I collect" — otherwise a resumed walk always looks
    // truncated and a caller would refuse to answer a question it had answered.
    servePagedCatalog(250, 100);

    const catalog = await client().listMarkets({ chainId: 1, skip: 100 });

    expect(catalog.markets).toHaveLength(150);
    expect(catalog.complete).toBe(true);
    expect(catalog.pagesFetched).toBe(2);
  });

  it("does not re-fetch a row the validator dropped", async () => {
    // One unreadable row per page must not shift the next offset backwards.
    mockReadJson.mockImplementation((r: FakeResponse) => Promise.resolve(r.__json));
    mockFetch.mockImplementation((url: string) => {
      const skip = Number(new URL(String(url)).searchParams.get("skip") ?? "0");
      const results = Array.from({ length: 100 }, (_v, i) => ({
        chainId: 1,
        // The first row of every page is unreadable.
        address: i === 0 ? "not-an-address" : `0x${String(skip + i).padStart(40, "0")}`,
        details: {},
      }));
      return Promise.resolve(okResponse({ total: 200, limit: 100, skip, results }));
    });

    const catalog = await client().listMarkets({ chainId: 1 });

    expect(requestedUrls().map((u) => new URL(u).searchParams.get("skip"))).toEqual(["0", "100"]);
    expect(catalog.markets).toHaveLength(198);
    expect(catalog.complete).toBe(true);
  });
});

describe("PendleReadClient error contract", () => {
  function serveStatus(status: number): void {
    mockReadJson.mockImplementation((r: FakeResponse) => Promise.resolve(r.__json));
    mockFetch.mockImplementation(() => Promise.resolve(errorResponse(status)));
  }

  it("maps a 404 to a DEFINITIVE market-not-found carrying httpStatus", async () => {
    serveStatus(404);

    await expect(client().getSwappingPrices(1, ACTIVE_MARKET)).rejects.toMatchObject({
      code: ErrorCodes.PENDLE_MARKET_NOT_FOUND,
      httpStatus: 404,
      retryable: false,
    });
  });

  it("maps a 400 to a definitive refusal — retrying it only spends compute units", async () => {
    serveStatus(400);

    await expect(client().getMarketPage()).rejects.toMatchObject({
      code: ErrorCodes.PENDLE_API_ERROR,
      httpStatus: 400,
      retryable: false,
    });
  });

  it("maps a 429 and a 500 to RETRYABLE errors", async () => {
    serveStatus(429);
    await expect(client().getMarketPage()).rejects.toMatchObject({
      code: ErrorCodes.PENDLE_RATE_LIMITED,
      httpStatus: 429,
      retryable: true,
    });

    vi.clearAllMocks();
    serveStatus(503);
    await expect(client().getMarketPage()).rejects.toMatchObject({
      code: ErrorCodes.PENDLE_API_ERROR,
      httpStatus: 503,
      retryable: true,
    });
  });

  it("NEVER copies the upstream body into the thrown message", async () => {
    serveStatus(400);

    await expect(client().getMarketPage()).rejects.toSatisfy(
      (err: unknown) => err instanceof VexError && !err.message.includes("hostile upstream text"),
    );
  });

  it("leaves httpStatus ABSENT on a transport failure, and marks it retryable", async () => {
    mockFetch.mockImplementation(() => Promise.reject(new VexError(ErrorCodes.HTTP_TIMEOUT, "timed out")));

    const err = await client().getMarketPage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VexError);
    expect((err as VexError).code).toBe(ErrorCodes.PENDLE_TIMEOUT);
    expect((err as VexError).httpStatus).toBeUndefined();
    expect((err as VexError).retryable).toBe(true);
  });

  it("does NOT cache a shape failure — the next read retries the provider", async () => {
    serve({ nothing: "useful" });
    const read = client();

    await expect(read.getMarketPage()).rejects.toMatchObject({ code: ErrorCodes.PENDLE_INVALID_RESPONSE });
    await expect(read.getMarketPage()).rejects.toMatchObject({ code: ErrorCodes.PENDLE_INVALID_RESPONSE });
    expect(mockFetch.mock.calls).toHaveLength(2);
  });

  it("serves a repeated identical read from the TTL cache", async () => {
    serve(PENDLE_ORDERBOOK);
    const read = client();

    await read.getOrderbook(1, ACTIVE_MARKET, { precisionDecimal: 2 });
    await read.getOrderbook(1, ACTIVE_MARKET, { precisionDecimal: 2 });

    expect(mockFetch.mock.calls).toHaveLength(1);
  });
});
