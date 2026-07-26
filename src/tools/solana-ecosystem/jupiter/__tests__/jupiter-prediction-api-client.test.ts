import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchJson = vi.fn();
function callMock<T>(mock: unknown, args: unknown[]): T {
  return (mock as (...innerArgs: unknown[]) => T)(...args);
}
vi.mock("@utils/http.js", () => ({
  fetchJson: (...args: unknown[]) => callMock(mockFetchJson, args),
}));

const {
  jupiterPredictionEvents,
  jupiterPredictionSearchEvents,
  jupiterPredictionEvent,
  jupiterPredictionSuggestedEvents,
  jupiterPredictionEventMarkets,
  jupiterPredictionEventMarket,
  jupiterPredictionMarket,
  jupiterPredictionOrderbook,
  jupiterPredictionTradingStatus,
  jupiterPredictionOrders,
  jupiterPredictionOrder,
  jupiterPredictionOrderStatus,
  jupiterPredictionCreateOrder,
  jupiterPredictionPositions,
  jupiterPredictionPosition,
  jupiterPredictionClosePosition,
  jupiterPredictionCloseAllPositions,
  jupiterPredictionClaimPosition,
  jupiterPredictionExecute,
  jupiterPredictionHistory,
  jupiterPredictionProfile,
  jupiterPredictionPnlHistory,
  jupiterPredictionTrades,
  jupiterPredictionLeaderboards,
  jupiterPredictionVaultInfo,
} = await import("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/client.js");

const USER = "GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ";
const ORDER = "gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB";
const POSITION = "7xKXtg2CWwM2s7x8H8sZZtP2C2xY2hW3ni8dD8R9Lk8m";
const MARKET_PUBKEY = "J4xzYC2bM7S3uMgb9HuJp79Yf9sQf5kLk4m4T8v3Lgr";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPUSD = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
const EVENT_ID = "event-123";
const MARKET_ID = "market-456";

describe("jupiter prediction api client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, JUPITER_API_KEY: "test-jupiter-key" };
  });

  it("calls discovery and market endpoints with normalized query params and x-api-key", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ data: [], pagination: { start: 0, end: 0, total: 0, hasNext: false } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ eventId: EVENT_ID })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [], pagination: { start: 0, end: 20, total: 0, hasNext: false } })
      .mockResolvedValueOnce({ marketId: MARKET_ID })
      .mockResolvedValueOnce({ marketId: MARKET_ID })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ trading_active: true });

    await jupiterPredictionEvents({
      provider: "polymarket",
      category: "crypto",
      filter: "trending",
      includeMarkets: true,
      subcategory: ["solana", "layer1"],
      sortBy: "volume",
      sortDirection: "desc",
      start: 0,
      end: 50,
    });
    await jupiterPredictionSearchEvents({ provider: "kalshi", query: "nba", limit: 10 });
    await jupiterPredictionEvent({ eventId: EVENT_ID, includeMarkets: true });
    await jupiterPredictionSuggestedEvents({ pubkey: USER, provider: "polymarket" });
    await jupiterPredictionEventMarkets({ eventId: EVENT_ID, start: 0, end: 20 });
    await jupiterPredictionEventMarket({ eventId: EVENT_ID, marketId: MARKET_ID });
    await jupiterPredictionMarket({ marketId: MARKET_ID });
    await jupiterPredictionOrderbook({ marketId: MARKET_ID });
    await jupiterPredictionTradingStatus();

    const [eventsUrl, eventsOpts] = mockFetchJson.mock.calls[0];
    expect(eventsUrl).toBe(
      "https://api.jup.ag/prediction/v1/events?provider=polymarket&includeMarkets=true&start=0&end=50&category=crypto&subcategory=solana%2Clayer1&sortBy=volume&sortDirection=desc&filter=trending",
    );
    expect(eventsOpts.headers).toEqual({ "x-api-key": "test-jupiter-key" });

    const [searchUrl] = mockFetchJson.mock.calls[1];
    expect(searchUrl).toBe(
      "https://api.jup.ag/prediction/v1/events/search?provider=kalshi&query=nba&limit=10",
    );

    const [eventUrl] = mockFetchJson.mock.calls[2];
    expect(eventUrl).toBe(
      "https://api.jup.ag/prediction/v1/events/event-123?includeMarkets=true",
    );

    // LIVE-GATE FIX 1 (2026-07-24): pubkey is a query param on the base
    // `/events/suggested` route, not a path segment — the old
    // `/events/suggested/{pubkey}` path 404s live (route not registered).
    const [suggestedUrl] = mockFetchJson.mock.calls[3];
    expect(suggestedUrl).toBe(
      `https://api.jup.ag/prediction/v1/events/suggested?pubkey=${USER}&provider=polymarket`,
    );

    const [eventMarketsUrl] = mockFetchJson.mock.calls[4];
    expect(eventMarketsUrl).toBe(
      "https://api.jup.ag/prediction/v1/events/event-123/markets?start=0&end=20",
    );

    const [eventMarketUrl] = mockFetchJson.mock.calls[5];
    expect(eventMarketUrl).toBe(
      "https://api.jup.ag/prediction/v1/events/event-123/markets/market-456",
    );

    const [marketUrl] = mockFetchJson.mock.calls[6];
    expect(marketUrl).toBe("https://api.jup.ag/prediction/v1/markets/market-456");

    const [orderbookUrl] = mockFetchJson.mock.calls[7];
    expect(orderbookUrl).toBe("https://api.jup.ag/prediction/v1/orderbook/market-456");

    const [tradingUrl] = mockFetchJson.mock.calls[8];
    expect(tradingUrl).toBe("https://api.jup.ag/prediction/v1/trading-status");
  });

  it("calls portfolio, history, and analytics endpoints with normalized filters", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ data: [], pagination: { start: 1, end: 10, total: 0, hasNext: false } })
      .mockResolvedValueOnce({ pubkey: ORDER })
      .mockResolvedValueOnce({ orderPubkey: ORDER, history: [] })
      .mockResolvedValueOnce({ data: [], pagination: { start: 0, end: 25, total: 0, hasNext: false } })
      .mockResolvedValueOnce({ pubkey: POSITION })
      .mockResolvedValueOnce({ data: [], pagination: { start: 0, end: 10, total: 0, hasNext: false } })
      .mockResolvedValueOnce({ ownerPubkey: USER })
      .mockResolvedValueOnce({ ownerPubkey: USER, history: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [], summary: { all_time: { totalVolumeUsd: "0", predictionsCount: 0 }, weekly: { totalVolumeUsd: "0", predictionsCount: 0 }, monthly: { totalVolumeUsd: "0", predictionsCount: 0 } } })
      .mockResolvedValueOnce({ pubkey: "vault", data: {}, vaultBalance: "0" });

    await jupiterPredictionOrders({ ownerPubkey: USER, start: 1, end: 10 });
    await jupiterPredictionOrder({ orderPubkey: ORDER });
    await jupiterPredictionOrderStatus({ orderPubkey: ORDER });
    await jupiterPredictionPositions({
      ownerPubkey: USER,
      marketPubkey: MARKET_PUBKEY,
      marketId: MARKET_ID,
      isYes: false,
      start: 0,
      end: 25,
    });
    await jupiterPredictionPosition({ positionPubkey: POSITION });
    await jupiterPredictionHistory({
      ownerPubkey: USER,
      positionPubkey: POSITION,
      id: 3,
      start: 0,
      end: 10,
    });
    await jupiterPredictionProfile({ ownerPubkey: USER });
    await jupiterPredictionPnlHistory({ ownerPubkey: USER, interval: "1w", count: 12 });
    await jupiterPredictionTrades();
    await jupiterPredictionLeaderboards({ period: "weekly", metric: "pnl", limit: 10 });
    await jupiterPredictionVaultInfo();

    expect(mockFetchJson.mock.calls[0][0]).toBe(
      `https://api.jup.ag/prediction/v1/orders?start=1&end=10&ownerPubkey=${USER}`,
    );
    expect(mockFetchJson.mock.calls[1][0]).toBe(
      `https://api.jup.ag/prediction/v1/orders/${ORDER}`,
    );
    expect(mockFetchJson.mock.calls[2][0]).toBe(
      `https://api.jup.ag/prediction/v1/orders/status/${ORDER}`,
    );
    expect(mockFetchJson.mock.calls[3][0]).toBe(
      `https://api.jup.ag/prediction/v1/positions?start=0&end=25&ownerPubkey=${USER}&marketPubkey=${MARKET_PUBKEY}&marketId=${MARKET_ID}&isYes=false`,
    );
    expect(mockFetchJson.mock.calls[4][0]).toBe(
      `https://api.jup.ag/prediction/v1/positions/${POSITION}`,
    );
    expect(mockFetchJson.mock.calls[5][0]).toBe(
      `https://api.jup.ag/prediction/v1/history?start=0&end=10&ownerPubkey=${USER}&id=3&positionPubkey=${POSITION}`,
    );
    expect(mockFetchJson.mock.calls[6][0]).toBe(
      `https://api.jup.ag/prediction/v1/profiles/${USER}`,
    );
    expect(mockFetchJson.mock.calls[7][0]).toBe(
      `https://api.jup.ag/prediction/v1/profiles/${USER}/pnl-history?interval=1w&count=12`,
    );
    expect(mockFetchJson.mock.calls[8][0]).toBe("https://api.jup.ag/prediction/v1/trades");
    expect(mockFetchJson.mock.calls[9][0]).toBe(
      "https://api.jup.ag/prediction/v1/leaderboards?period=weekly&limit=10&metric=pnl",
    );
    expect(mockFetchJson.mock.calls[10][0]).toBe("https://api.jup.ag/prediction/v1/vault-info");
  });

  it("calls transaction endpoints with POST or DELETE json bodies", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ transaction: "buy-base64", txMeta: { blockhash: "bh", lastValidBlockHeight: 1 }, externalOrderId: "ext", order: { orderPubkey: ORDER } })
      .mockResolvedValueOnce({ transaction: "sell-base64", txMeta: { blockhash: "bh", lastValidBlockHeight: 1 }, externalOrderId: "ext", order: { orderPubkey: ORDER } })
      .mockResolvedValueOnce({ transaction: "close-base64", txMeta: { blockhash: "bh", lastValidBlockHeight: 1 }, externalOrderId: "ext", order: { orderPubkey: ORDER } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ transaction: "claim-base64", txMeta: { blockhash: "bh", lastValidBlockHeight: 1 }, position: { positionPubkey: POSITION } })
      .mockResolvedValueOnce({ status: "Success", signature: "sig-1", error: null });

    await jupiterPredictionCreateOrder({
      ownerPubkey: USER,
      marketId: MARKET_ID,
      isYes: true,
      isBuy: true,
      depositAmount: 2_000_000,
      depositMint: JUPUSD,
    });
    await jupiterPredictionCreateOrder({
      ownerPubkey: USER,
      positionPubkey: POSITION,
      isBuy: false,
      contracts: 5,
    });
    await jupiterPredictionClosePosition(POSITION, { ownerPubkey: USER });
    await jupiterPredictionCloseAllPositions({ ownerPubkey: USER, minSellPriceSlippageBps: 100 });
    await jupiterPredictionClaimPosition(POSITION, { ownerPubkey: USER });
    await jupiterPredictionExecute({ signedTransaction: "signed-base64", context: { type: "bisonfi_swap" } });

    const [buyUrl, buyOpts] = mockFetchJson.mock.calls[0];
    expect(buyUrl).toBe("https://api.jup.ag/prediction/v1/orders");
    expect(buyOpts.method).toBe("POST");
    expect(buyOpts.headers).toEqual({
      "x-api-key": "test-jupiter-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(buyOpts.body)).toEqual({
      ownerPubkey: USER,
      marketId: MARKET_ID,
      isYes: true,
      isBuy: true,
      depositAmount: "2000000",
      depositMint: JUPUSD,
    });

    const [, sellOpts] = mockFetchJson.mock.calls[1];
    expect(JSON.parse(sellOpts.body)).toEqual({
      ownerPubkey: USER,
      positionPubkey: POSITION,
      isBuy: false,
      contracts: "5",
    });

    const [closeUrl, closeOpts] = mockFetchJson.mock.calls[2];
    expect(closeUrl).toBe(`https://api.jup.ag/prediction/v1/positions/${POSITION}`);
    expect(closeOpts.method).toBe("DELETE");
    expect(JSON.parse(closeOpts.body)).toEqual({ ownerPubkey: USER });

    const [closeAllUrl, closeAllOpts] = mockFetchJson.mock.calls[3];
    expect(closeAllUrl).toBe("https://api.jup.ag/prediction/v1/positions");
    expect(closeAllOpts.method).toBe("DELETE");
    expect(JSON.parse(closeAllOpts.body)).toEqual({ ownerPubkey: USER, minSellPriceSlippageBps: 100 });

    const [claimUrl, claimOpts] = mockFetchJson.mock.calls[4];
    expect(claimUrl).toBe(`https://api.jup.ag/prediction/v1/positions/${POSITION}/claim`);
    expect(claimOpts.method).toBe("POST");
    expect(JSON.parse(claimOpts.body)).toEqual({ ownerPubkey: USER });

    const [executeUrl, executeOpts] = mockFetchJson.mock.calls[5];
    expect(executeUrl).toBe("https://api.jup.ag/prediction/v1/execute");
    expect(executeOpts.method).toBe("POST");
    expect(JSON.parse(executeOpts.body)).toEqual({
      signedTransaction: "signed-base64", context: { type: "bisonfi_swap" },
    });
  });

  it("rejects invalid inputs and missing API key before fetching", async () => {
    delete process.env.JUPITER_API_KEY;
    await expect(jupiterPredictionEvents()).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });

    process.env.JUPITER_API_KEY = "test-jupiter-key";

    await expect(
      jupiterPredictionSearchEvents({ query: "", limit: 1 }),
    ).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });

    await expect(
      jupiterPredictionSuggestedEvents({ pubkey: "not-a-pubkey" }),
    ).rejects.toMatchObject({ code: "SOLANA_INVALID_ADDRESS" });

    await expect(
      jupiterPredictionEvents({ provider: "bad-provider" as "polymarket" }),
    ).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });

    await expect(
      jupiterPredictionCreateOrder({
        ownerPubkey: USER,
        marketId: MARKET_ID,
        isYes: true,
        isBuy: true,
        depositMint: USDC,
      }),
    ).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });

    await expect(
      jupiterPredictionCreateOrder({
        ownerPubkey: USER,
        positionPubkey: POSITION,
        isBuy: false,
        contracts: 1,
        depositMint: USDC,
      }),
    ).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });

    // Batch-4-closure blocker 2: minSellPriceSlippageBps is REQUIRED (no
    // silent default) with a Vex-side 0-10,000 bps product-safety bound.
    await expect(
      jupiterPredictionCloseAllPositions({ ownerPubkey: USER } as never),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });

    await expect(
      jupiterPredictionCloseAllPositions({ ownerPubkey: USER, minSellPriceSlippageBps: 10_001 }),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });

    await expect(
      jupiterPredictionCloseAllPositions({ ownerPubkey: USER, minSellPriceSlippageBps: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });

    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});
