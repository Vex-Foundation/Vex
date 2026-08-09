import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../errors.js";
import { LighterClient } from "@tools/lighter/client.js";
import { describeLighterBody, mapLighterError } from "@tools/lighter/errors.js";
import type { LighterEndpointConfig, LighterEnvironment } from "@tools/lighter/constants.js";

const ENDPOINTS: Record<LighterEnvironment, LighterEndpointConfig> = {
  core: {
    restBaseUrl: "https://core.example",
    wsUrl: "wss://core.example/stream",
    readonlyWsUrl: "wss://core.example/stream?readonly=true",
  },
  rhc: {
    restBaseUrl: "https://rhc.example",
    wsUrl: "wss://rhc.example/stream",
    readonlyWsUrl: "wss://rhc.example/stream?readonly=true",
  },
};

const MARKET = {
  symbol: "ETH",
  market_id: 0,
  market_type: "perp",
  base_asset_id: 1,
  quote_asset_id: 0,
  status: "active",
  taker_fee: "0",
  maker_fee: "0",
  liquidation_fee: "0",
  min_base_amount: "10",
  min_quote_amount: "100",
  supported_size_decimals: 4,
  supported_price_decimals: 2,
  supported_quote_decimals: 6,
  order_quote_limit: "1000000000",
  is_maker_fee_enabled: true,
  is_taker_fee_enabled: true,
};

const ORDER = {
  order_index: 1,
  order_id: "123",
  owner_account_index: 7,
  initial_base_amount: "10",
  remaining_base_amount: "5",
  price: "300000",
  order_expiry: 0,
  transaction_time: 1717777777,
};

const TRADE = {
  trade_id: 1,
  trade_id_str: "1",
  tx_hash: "0xabc",
  type: "trade",
  market_id: 0,
  size: "0.1",
  price: "3000",
  usd_amount: "300",
  ask_id: 1,
  ask_id_str: "1",
  bid_id: 2,
  bid_id_str: "2",
  ask_account_id: 3,
  bid_account_id: 4,
  is_maker_ask: false,
  block_height: 5,
  timestamp: 1717777777,
};

const UNSAFE_INTEGER = Number.MAX_SAFE_INTEGER + 1;

const originalFetch = globalThis.fetch;
let client: LighterClient;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  client = new LighterClient(ENDPOINTS);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockOk(data: unknown) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    headers: new Headers(),
    json: async () => data,
  });
}

function mockError(status: number, body?: unknown, headers?: { get?: (name: string) => string | null }) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: false,
    status,
    headers: headers ?? new Headers(),
    json: async () => body ?? null,
    text: async () => text,
  });
}

function lastUrl(): URL {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return new URL(calls[calls.length - 1][0] as string);
}

describe("LighterClient URL selection", () => {
  it("selects the Core base URL", async () => {
    mockOk({ status: 1, network_id: 304, timestamp: 1717777777 });
    await client.getStatus("core");
    expect(lastUrl().origin).toBe("https://core.example");
    expect(lastUrl().pathname).toBe("/");
  });

  it("selects the RHC base URL", async () => {
    mockOk({ status: 1, network_id: 4663, timestamp: 1717777777 });
    await client.getStatus("rhc");
    expect(lastUrl().origin).toBe("https://rhc.example");
  });

  it("translates market query params to Lighter snake_case", async () => {
    mockOk({ code: 200, order_books: [MARKET] });
    await client.getMarkets("core", { marketId: 0, filter: "perp" });
    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/orderBooks");
    expect(url.searchParams.get("market_id")).toBe("0");
    expect(url.searchParams.get("filter")).toBe("perp");
  });

  it("does not attach Authorization to public reads", async () => {
    mockOk({ status: 1, network_id: 304, timestamp: 1717777777 });
    await client.getStatus("core");
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("attaches Authorization from the privileged provider for authenticated reads", async () => {
    mockOk({ code: 200, tokens: [] });
    const authClient = new LighterClient(
      ENDPOINTS,
      undefined,
      (environment, mode) => `ro-token-for-${environment}-${mode}`,
    );

    await authClient.getReadOnlyTokens("rhc", { accountIndex: 42 });
    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/tokens");
    expect(url.searchParams.get("account_index")).toBe("42");
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("ro-token-for-rhc-read-only");
  });

  it("builds authenticated account order read params", async () => {
    mockOk({ code: 200, orders: [] });
    mockOk({ code: 200, orders: [] });
    const authClient = new LighterClient(ENDPOINTS, undefined, () => "ro:42:all:4102444800:abcdef");

    await authClient.getAccountActiveOrders("core", {
      accountIndex: 42,
      marketId: 0,
      marketType: "perp",
    });
    let url = lastUrl();
    expect(url.pathname).toBe("/api/v1/accountActiveOrders");
    expect(url.searchParams.get("account_index")).toBe("42");
    expect(url.searchParams.get("market_id")).toBe("0");
    expect(url.searchParams.get("market_type")).toBe("perp");

    await authClient.getAccountInactiveOrders("core", {
      accountIndex: 42,
      limit: 1,
    });
    url = lastUrl();
    expect(url.pathname).toBe("/api/v1/accountInactiveOrders");
    expect(url.searchParams.get("account_index")).toBe("42");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("does not cache authenticated reads", async () => {
    mockOk({ code: 200, tokens: [{ token_id: "first" }] });
    mockOk({ code: 200, tokens: [{ token_id: "second" }] });
    const authClient = new LighterClient(ENDPOINTS, undefined, () => "ro:42:all:4102444800:abcdef");

    const first = await authClient.getReadOnlyTokens("core", { accountIndex: 42 });
    const second = await authClient.getReadOnlyTokens("core", { accountIndex: 42 });

    expect(first.tokens[0]?.token_id).toBe("first");
    expect(second.tokens[0]?.token_id).toBe("second");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds order book limits before sending", async () => {
    await expect(client.getOrderBookOrders("core", { marketId: 0, limit: 251 })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown environment before sending", async () => {
    await expect(client.getStatus("prod" as never)).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      message: "Invalid Lighter environment: prod",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("builds candles params and derives countBack from a bounded range", async () => {
    mockOk({
      code: 200,
      r: "1m",
      c: [{ t: 1717770000000, o: 1, h: 2, l: 1, c: 2, v: 3, V: 4, i: 5 }],
    });
    await client.getCandles("core", {
      marketId: 0,
      resolution: "1m",
      startTimestamp: 1717770000000,
      endTimestamp: 1717770060000,
    });
    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/candles");
    expect(url.searchParams.get("market_id")).toBe("0");
    expect(url.searchParams.get("resolution")).toBe("1m");
    expect(url.searchParams.get("count_back")).toBe("1");
  });

  it("rejects broad candle ranges that exceed countBack", async () => {
    await expect(
      client.getCandles("core", {
        marketId: 0,
        resolution: "1m",
        startTimestamp: 1717770000000,
        endTimestamp: 1717773600000,
        countBack: 10,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.LIGHTER_INVALID_REQUEST });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects seconds-scale candle timestamps by name", async () => {
    await expect(
      client.getCandles("core", {
        marketId: 0,
        resolution: "1m",
        startTimestamp: 1_717_770_000,
        endTimestamp: 1_717_770_060,
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      message: "Invalid Lighter startTimestamp: expected epoch milliseconds, not seconds",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("LighterClient validation", () => {
  it("validates market details including spot detail defaults", async () => {
    mockOk({ code: 200, order_book_details: [{ ...MARKET, last_trade_price: 3000 }] });
    const details = await client.getMarketDetails("core", { marketId: 0 });
    expect(details.order_book_details[0].symbol).toBe("ETH");
    expect(details.spot_order_book_details).toEqual([]);
  });

  it("validates order book orders", async () => {
    mockOk({ code: 200, total_asks: 1, asks: [ORDER], total_bids: 1, bids: [ORDER] });
    const book = await client.getOrderBookOrders("core", { marketId: 0, limit: 1 });
    expect(book.asks[0].remaining_base_amount).toBe("5");
  });

  it("rejects non-decimal exact order ids", async () => {
    mockOk({
      code: 200,
      total_asks: 1,
      asks: [{ ...ORDER, order_id: "order-1" }],
      total_bids: 0,
      bids: [],
    });
    await expect(client.getOrderBookOrders("core", { marketId: 0, limit: 1 })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_RESPONSE,
    });
  });

  it("validates recent trades", async () => {
    mockOk({ code: 200, trades: [TRADE] });
    const tape = await client.getRecentTrades("core", { marketId: 0, limit: 1 });
    expect(tape.trades[0].price).toBe("3000");
    expect(tape.trades[0].ask_id_str).toBe("1");
  });

  it("requires exact string ids on recent trades", async () => {
    const { ask_id_str: _askIdStr, ...tradeWithoutAskString } = TRADE;
    mockOk({ code: 200, trades: [tradeWithoutAskString] });
    await expect(client.getRecentTrades("core", { marketId: 0, limit: 1 })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_RESPONSE,
    });
  });

  it("rejects non-decimal exact trade ids", async () => {
    mockOk({
      code: 200,
      trades: [{
        ...TRADE,
        trade_id: UNSAFE_INTEGER,
        trade_id_str: "trade-9007199254740992",
      }],
    });
    await expect(client.getRecentTrades("core", { marketId: 0, limit: 1 })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_RESPONSE,
    });
  });

  it("rejects malformed provider responses", async () => {
    mockOk({ code: 200, order_books: [{ market_id: 0 }] });
    await expect(client.getMarkets("core")).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_RESPONSE,
    });
  });

  it("rejects overlarge candle responses", async () => {
    const candle = { t: 1717770000000, o: 1, h: 2, l: 1, c: 2, v: 3, V: 4, i: 5 };
    mockOk({ code: 200, r: "1m", c: Array.from({ length: 501 }, () => candle) });
    await expect(
      client.getCandles("core", {
        marketId: 0,
        resolution: "1m",
        startTimestamp: 1717770000000,
        endTimestamp: 1717770060000,
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_RESPONSE,
      hint: "Narrow the candle time range before retrying.",
    });
  });
});

describe("Lighter error mapping", () => {
  it("maps rate limits to retryable LIGHTER_RATE_LIMITED", async () => {
    mockError(429, { message: "too many requests" }, new Headers({ "retry-after": "2" }));
    await expect(client.getStatus("core")).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_RATE_LIMITED,
      httpStatus: 429,
      retryable: true,
    });
  });

  it("surfaces non-JSON error bodies after safe scrubbing", async () => {
    mockError(403, "<html><body>blocked at https://edge.example/path?token=secret</body></html>");
    let thrown: unknown;
    try {
      await client.getStatus("core");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      httpStatus: 403,
    });
    const { message } = thrown as { message: string };
    expect(message).toContain("HTTP 403");
    expect(message).toContain("(html)");
    expect(message).not.toContain("edge.example");
    expect(message).not.toContain("token=secret");
  });

  it("maps transport failure to LIGHTER_API_ERROR", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.getStatus("core")).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_API_ERROR,
      retryable: true,
    });
  });

  it("redacts and bounds provider body excerpts", () => {
    const secret = "sk-ant-abcdef0123456789abcdef0123456789";
    const excerpt = describeLighterBody({ error: `${secret} ${"x".repeat(500)}` });
    expect(excerpt).not.toContain(secret);
    expect(excerpt?.length).toBeLessThanOrEqual(203);
  });

  it("redacts Lighter read-only auth tokens from provider bodies", () => {
    const token = "ro:42:all:4102444800:abcdef0123456789";
    const excerpt = describeLighterBody({
      message: `Authorization failed for ${token} and auth=${token}`,
    });
    expect(excerpt).not.toContain(token);
    expect(excerpt).not.toContain("abcdef0123456789");
    expect(excerpt).toContain("[auth]");
  });

  it("keeps HTTP status when surfacing provider bodies", () => {
    const error = mapLighterError("rhc", 400, { error: { message: "bad market_id" } });
    expect(error.code).toBe(ErrorCodes.LIGHTER_INVALID_REQUEST);
    expect(error.httpStatus).toBe(400);
    expect(error.message).toContain("HTTP 400");
    expect(error.message).toContain("bad market_id");
  });
});
