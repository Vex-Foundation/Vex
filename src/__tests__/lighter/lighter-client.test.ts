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
const UNSAFE_INTEGER_2 = Number.MAX_SAFE_INTEGER + 3;

const ACCOUNT_ORDER = {
  order_index: UNSAFE_INTEGER,
  client_order_index: UNSAFE_INTEGER_2,
  order_id: String(UNSAFE_INTEGER),
  client_order_id: String(UNSAFE_INTEGER_2),
  market_index: 0,
  owner_account_index: 42,
  initial_base_amount: "100",
  price: "300000",
  remaining_base_amount: "50",
  filled_base_amount: "50",
  filled_quote_amount: "15000000",
  side: "buy",
  type: "limit",
  time_in_force: "good_till_time",
  reduce_only: false,
  order_expiry: 1786233600000,
  status: "open",
  block_height: 99,
  timestamp: 1786147200000,
  created_at: 1786147200000,
  updated_at: 1786147200001,
  transaction_time: 1786147200000,
};

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

  it("reads public L1 deposit metadata and exact transaction evidence", async () => {
    mockOk({
      contract_address: "0x1111111111111111111111111111111111111111",
    });
    mockOk({
      code: 200,
      l1_providers: [{ chainId: 1, networkId: 1, latestBlockNumber: 23456789 }],
      l1_providers_health: true,
      contract_addresses: [{ name: "ZkLighterContract", address: "0x1111111111111111111111111111111111111111" }],
    });
    mockOk({
      code: 200,
      asset_details: [{
        asset_id: 3,
        symbol: "USDC",
        l1_decimals: 6,
        decimals: 6,
        min_transfer_amount: "1.000000",
        l1_address: "0x2222222222222222222222222222222222222222",
      }],
    });
    mockOk({
      code: 200,
      hash: "0xlighter",
      type: 1,
      info: "{\"AccountIndex\":42}",
      event_info: "{\"a\":42}",
      status: 3,
      transaction_index: 1,
      l1_address: "0x3333333333333333333333333333333333333333",
      account_index: 42,
      nonce: -1,
      expire_at: 9223372036854775807,
      block_height: 99,
      queued_at: 1786949159112,
      executed_at: 1786949159112,
      sequence_index: 114939818073,
      parent_hash: "",
      api_key_index: 0,
      transaction_time: 1786949159275021,
      committed_at: 0,
      verified_at: 0,
    });

    const info = await client.getInfo("core");
    expect(lastUrl().pathname).toBe("/info");
    expect(info.contract_address).toBe("0x1111111111111111111111111111111111111111");

    const l1 = await client.getLayer1BasicInfo("core");
    expect(lastUrl().pathname).toBe("/api/v1/layer1BasicInfo");
    expect(l1.contract_addresses[0]?.name).toBe("ZkLighterContract");

    const assets = await client.getAssetDetails("core");
    expect(lastUrl().pathname).toBe("/api/v1/assetDetails");
    expect(assets.asset_details[0]?.asset_id).toBe(3);

    const evidence = await client.getTxFromL1("core", { hash: " 0xdeposit " });
    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/txFromL1TxHash");
    expect(url.searchParams.get("hash")).toBe("0xdeposit");
    expect(evidence.account_index).toBe(42);
  });

  it("reads every wallet-owned Lighter subaccount without guessing the first row", async () => {
    mockOk({
      code: 200,
      l1_address: "0x3333333333333333333333333333333333333333",
      sub_accounts: [
        { account_type: 0, index: 42, l1_address: "0x3333333333333333333333333333333333333333" },
        { account_type: 1, index: 43, l1_address: "0x3333333333333333333333333333333333333333" },
      ],
      next_cursor: "page-2",
    });

    const response = await client.getAccountsByL1Address("core", {
      l1Address: " 0x3333333333333333333333333333333333333333 ",
      cursor: " page-1 ",
    });

    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/accountsByL1Address");
    expect(url.searchParams.get("l1_address")).toBe("0x3333333333333333333333333333333333333333");
    expect(url.searchParams.get("cursor")).toBe("page-1");
    expect(response.sub_accounts.map((account) => account.index)).toEqual([42, 43]);
  });

  it("validates the official account position shape before returning it", async () => {
    mockOk({
      code: 200,
      accounts: [{
        index: 42,
        l1_address: "0x3333333333333333333333333333333333333333",
        positions: [{
          market_id: 0,
          symbol: "ETH",
          initial_margin_fraction: "0.05",
          open_order_count: 0,
          pending_order_count: 0,
          position_tied_order_count: 0,
          sign: 1,
          position: "0.1000",
          avg_entry_price: "3000.00",
          position_value: "300.00",
          unrealized_pnl: "1.25",
          realized_pnl: "0.00",
          liquidation_price: "2500.00",
          total_funding_paid_out: "0.01",
          margin_mode: 0,
          allocated_margin: "15.00",
          total_discount: "0.00",
        }],
      }],
    });

    const response = await client.getAccount("core", { by: "index", value: 42 });

    expect(lastUrl().pathname).toBe("/api/v1/account");
    expect(response.accounts[0]?.positions?.[0]?.position).toBe("0.1000");
  });

  it("rejects an incomplete account position response", async () => {
    mockOk({
      code: 200,
      accounts: [{
        index: 42,
        positions: [{ market_id: 0, symbol: "ETH", sign: 1, position: "0.1000" }],
      }],
    });

    await expect(client.getAccount("core", { by: "index", value: 42 })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_RESPONSE,
    });
  });

  it("rejects empty deposit evidence query values before sending", async () => {
    await expect(client.getTxFromL1("core", { hash: "  " })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
    });
    await expect(client.getAccountsByL1Address("core", { l1Address: "" })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not attach Authorization to public reads", async () => {
    mockOk({ status: 1, network_id: 304, timestamp: 1717777777 });
    await client.getStatus("core");
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("reads public API-key nonce metadata without Authorization", async () => {
    mockOk({
      code: 200,
      api_keys: [{
        account_index: 42,
        api_key_index: 1,
        nonce: 1784732515923,
        public_key: "96432015bb5cb590489b59727a29deeca4a55d6f416cd28c48220ec3572a1fcfe0d6b21b9b1f852a",
        transaction_time: 1784732516903382,
      }],
    });

    const response = await client.getApiKeys("rhc", { accountIndex: 42, apiKeyIndex: 255 });

    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/apikeys");
    expect(url.searchParams.get("account_index")).toBe("42");
    expect(url.searchParams.get("api_key_index")).toBe("255");
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(response.api_keys[0]?.nonce).toBe(1784732515923);
  });

  it("reads the exact live next nonce without Authorization", async () => {
    mockOk({ code: 200, nonce: 1784732515923 });

    const response = await client.getNextNonce("rhc", {
      accountIndex: 42,
      apiKeyIndex: 7,
    });

    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/nextNonce");
    expect(url.searchParams.get("account_index")).toBe("42");
    expect(url.searchParams.get("api_key_index")).toBe("7");
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(response.nonce).toBe(1784732515923);
  });

  it("rejects the API-key listing sentinel for next nonce reads", async () => {
    await expect(client.getNextNonce("core", {
      accountIndex: 42,
      apiKeyIndex: 255,
    })).rejects.toMatchObject({ code: ErrorCodes.LIGHTER_INVALID_REQUEST });
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

  it("uses exact privileged canonical auth without reading the read-only token provider", async () => {
    mockOk({ code: 200, orders: [] });
    const authProvider = vi.fn(() => { throw new Error("must not run"); });
    const authClient = new LighterClient(ENDPOINTS, undefined, authProvider);
    const token = `1893456600:42:7:${"a".repeat(128)}`;

    await authClient.getAccountActiveOrders(
      "rhc",
      { accountIndex: 42, marketId: 0 },
      { token, accountIndex: 42 },
    );

    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe(token);
    expect(authProvider).not.toHaveBeenCalled();
  });

  it("rejects privileged canonical auth for a different account before sending", async () => {
    await expect(client.getAccountActiveOrders(
      "rhc",
      { accountIndex: 42 },
      { token: `1893456600:43:7:${"a".repeat(128)}`, accountIndex: 43 },
    )).rejects.toMatchObject({ code: ErrorCodes.LIGHTER_INVALID_REQUEST });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("defaults authenticated account reads to the token account index", async () => {
    mockOk({ code: 200, orders: [] });
    const authClient = new LighterClient(ENDPOINTS, undefined, () => "ro:42:single:4102444800:abcdef");

    await authClient.getAccountActiveOrders("core", {});

    const url = lastUrl();
    expect(url.pathname).toBe("/api/v1/accountActiveOrders");
    expect(url.searchParams.get("account_index")).toBe("42");
  });

  it("refuses account reads outside a single-account token before sending", async () => {
    const authClient = new LighterClient(ENDPOINTS, undefined, () => "ro:42:single:4102444800:abcdef");

    await expect(
      authClient.getAccountActiveOrders("core", { accountIndex: 43 }),
    ).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      message: "Lighter read-only auth token for core is scoped to account 42, not account 43.",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

  it("bounds API-key index reads before sending", async () => {
    await expect(client.getApiKeys("core", { accountIndex: 42, apiKeyIndex: 256 })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      message: "Invalid Lighter apiKeyIndex: expected an integer from 0 to 255",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("builds signed transaction submit form data without auth headers", async () => {
    mockOk({
      code: 200,
      tx_hash: "0xabc123",
      predicted_execution_time_ms: 250,
      volume_quota_remaining: 10780,
    });

    const response = await client.sendTx("rhc", {
      txType: 14,
      txInfo: "{\"Nonce\":123,\"Sig\":\"0xabc\"}",
      priceProtection: true,
    });

    const url = lastUrl();
    expect(url.origin).toBe("https://rhc.example");
    expect(url.pathname).toBe("/api/v1/sendTx");
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    const body = init.body as URLSearchParams;
    expect(body.get("tx_type")).toBe("14");
    expect(body.get("tx_info")).toBe("{\"Nonce\":123,\"Sig\":\"0xabc\"}");
    expect(body.get("price_protection")).toBe("true");
    expect(response.tx_hash).toBe("0xabc123");
  });

  it("bounds signed transaction submit params before sending", async () => {
    await expect(client.sendTx("core", {
      txType: 256,
      txInfo: "{\"Nonce\":123}",
    })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      message: "Invalid Lighter txType: expected an integer from 0 to 255",
    });
    await expect(client.sendTx("core", {
      txType: 14,
      txInfo: "   ",
    })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      message: "Invalid Lighter txInfo: expected signed transaction info",
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

  it("preserves exact string ids on account order reads", async () => {
    mockOk({ code: 200, next_cursor: "cursor-1", orders: [ACCOUNT_ORDER] });
    const authClient = new LighterClient(ENDPOINTS, undefined, () => "ro:42:all:4102444800:abcdef");

    const response = await authClient.getAccountActiveOrders("core", { accountIndex: 42 });

    expect(response.next_cursor).toBe("cursor-1");
    expect(response.orders[0]?.order_id).toBe(String(UNSAFE_INTEGER));
    expect(response.orders[0]?.client_order_id).toBe(String(UNSAFE_INTEGER_2));
    expect(response.orders[0]?.order_index).toBe(UNSAFE_INTEGER);
  });

  it("requires exact string ids on account order reads", async () => {
    const { client_order_id: _clientOrderId, ...orderWithoutClientString } = ACCOUNT_ORDER;
    mockOk({ code: 200, orders: [orderWithoutClientString] });
    const authClient = new LighterClient(ENDPOINTS, undefined, () => "ro:42:all:4102444800:abcdef");

    await expect(authClient.getAccountActiveOrders("core", { accountIndex: 42 })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_RESPONSE,
    });
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

  it("validates public API-key nonce metadata", async () => {
    mockOk({
      code: 200,
      api_keys: [{
        account_index: 1,
        api_key_index: 1,
        nonce: 1784732515923,
        public_key: "96432015bb5cb590489b59727a29deeca4a55d6f416cd28c48220ec3572a1fcfe0d6b21b9b1f852a",
        transaction_time: 1784732516903382,
      }],
    });

    const response = await client.getApiKeys("core", { accountIndex: 1 });

    expect(response.api_keys).toHaveLength(1);
    expect(response.api_keys[0]?.api_key_index).toBe(1);
    expect(response.api_keys[0]?.public_key).toMatch(/^[a-f0-9]+$/);
  });

  it("rejects malformed API-key metadata", async () => {
    mockOk({
      code: 200,
      api_keys: [{
        account_index: 1,
        api_key_index: 1,
        public_key: "public",
        transaction_time: 1784732516903382,
      }],
    });

    await expect(client.getApiKeys("core", { accountIndex: 1 })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_RESPONSE,
    });
  });

  it("validates account trades with exact string ids", async () => {
    mockOk({ code: 200, trades: [TRADE] });
    const authClient = new LighterClient(ENDPOINTS, undefined, () => "ro:42:single:4102444800:abcdef");

    const tape = await authClient.getAccountTrades("core", { limit: 1 });

    expect(lastUrl().searchParams.get("account_index")).toBe("42");
    expect(tape.trades[0]?.trade_id_str).toBe("1");
    expect(tape.trades[0]?.ask_id_str).toBe("1");
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

  it("validates signed transaction submit acceptance shape", async () => {
    mockOk({
      code: 200,
      message: "ok",
      tx_hash: "0xabc123",
      predicted_execution_time_ms: 250,
      volume_quota_remaining: 10780,
    });

    const response = await client.sendTx("core", {
      txType: 14,
      txInfo: "{\"Nonce\":123,\"Sig\":\"0xabc\"}",
    });

    expect(response).toMatchObject({
      code: 200,
      tx_hash: "0xabc123",
      predicted_execution_time_ms: 250,
      volume_quota_remaining: 10780,
    });
  });

  it("accepts signed transaction submit responses without quota metadata", async () => {
    mockOk({
      code: 200,
      tx_hash: "0xabc123",
      predicted_execution_time_ms: 250,
    });

    const response = await client.sendTx("core", {
      txType: 14,
      txInfo: "{\"Nonce\":123,\"Sig\":\"0xabc\"}",
    });

    expect(response.tx_hash).toBe("0xabc123");
    expect(response.volume_quota_remaining).toBeUndefined();
  });

  it("rejects malformed signed transaction submit responses", async () => {
    mockOk({
      code: 200,
      volume_quota_remaining: 10780,
    });

    await expect(client.sendTx("core", {
      txType: 14,
      txInfo: "{\"Nonce\":123,\"Sig\":\"0xabc\"}",
    })).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_RESPONSE,
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

  it("redacts signed submit payloads from provider rejection errors", async () => {
    mockError(400, {
      message: "bad tx_info {\"Nonce\":123,\"Sig\":\"0xabc\",\"Secret\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}",
    });
    let thrown: unknown;
    try {
      await client.sendTx("rhc", {
        txType: 14,
        txInfo: "{\"Nonce\":123,\"Sig\":\"0xabc\"}",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      httpStatus: 400,
    });
    const { message } = thrown as { message: string };
    expect(message).toContain("signed transaction submission");
    expect(message).not.toContain("tx_info");
    expect(message).not.toContain("Sig");
    expect(message).not.toContain("0123456789abcdef");
  });
});
