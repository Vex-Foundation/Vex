import { afterEach, describe, expect, it, vi } from "vitest";

type IpcListener = (event: unknown, ...args: unknown[]) => void;
const listeners = new Map<string, Set<IpcListener>>();

const invoke = vi.fn(async () => ({ ok: true }));

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: IpcListener) => {
      const set = listeners.get(channel) ?? new Set<IpcListener>();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel: string, listener: IpcListener) => {
      listeners.get(channel)?.delete(listener);
    },
    invoke,
  },
}));

const { lighterTrading } = await import("../shell/lighter-trading.js");
const { CH, EV } = await import("../../shared/ipc/channels.js");

const subscriptionId = "00000000-0000-4000-8000-000000000225";
const candle = {
  timestamp: 1_787_530_000_000,
  open: 4_100,
  high: 4_250,
  low: 4_050,
  close: 4_200,
  volumeBase: 8,
  volumeQuote: 33_000,
  lastTradeId: "90071992547409939999",
  providerResolution: "1m",
  source: "websocket_update",
};
const event = {
  subscriptionId,
  environment: "rhc",
  marketId: 7,
  resolution: "1m",
  status: "live",
  providerTimestamp: 1_787_530_000_000,
  receivedAt: 1_787_530_000_050,
  candles: [candle],
};

function emit(channel: string, payload: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener({}, payload);
}

afterEach(() => {
  listeners.clear();
  vi.clearAllMocks();
});

describe("lighter trading preload candle boundary", () => {
  it("validates account reads before invoking main", async () => {
    const getAccountRaw = lighterTrading.getAccount as (
      input: unknown,
    ) => Promise<unknown>;

    await getAccountRaw({ environment: "rhc" });
    expect(invoke).toHaveBeenCalledWith(
      CH.lighterTrading.getAccount,
      expect.objectContaining({ payload: { environment: "rhc" } }),
    );

    invoke.mockClear();
    await getAccountRaw({
      environment: "rhc",
      authToken: "must-not-cross",
      accountIndex: 42,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates start and stop requests before invoking main", async () => {
    const startRaw = lighterTrading.startCandleSubscription as (
      input: unknown,
    ) => Promise<unknown>;
    await startRaw({
      subscriptionId,
      environment: "rhc",
      marketId: 7,
      resolution: "1m",
    });
    await lighterTrading.stopCandleSubscription({ subscriptionId });

    const calls = invoke.mock.calls as unknown as Array<[string, unknown]>;
    expect(calls[0]?.[0]).toBe(
      CH.lighterTrading.startCandleSubscription,
    );
    expect(calls[1]?.[0]).toBe(
      CH.lighterTrading.stopCandleSubscription,
    );
    invoke.mockClear();
    await startRaw({
      subscriptionId: "invalid",
      environment: "rhc",
      marketId: 7,
      resolution: "1m",
    });
    await startRaw({
      subscriptionId,
      environment: "rhc",
      marketId: 7,
      resolution: "1w",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("delivers only validated snapshot, update and status events", () => {
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    const onStatus = vi.fn();
    const offSnapshot = lighterTrading.onCandleSnapshot(onSnapshot);
    const offUpdate = lighterTrading.onCandleUpdate(onUpdate);
    const offStatus = lighterTrading.onCandleStatus(onStatus);

    emit(EV.lighterTrading.candleSnapshot, {
      ...event,
      candles: [{ ...candle, source: "rest_snapshot" }],
    });
    emit(EV.lighterTrading.candleUpdate, event);
    emit(EV.lighterTrading.candleUpdate, {
      ...event,
      candles: [{ ...candle, source: "raw_provider_payload", secret: true }],
    });
    emit(EV.lighterTrading.candleStatus, {
      ...event,
      status: "reconnecting",
      candles: [],
    });

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledTimes(1);
    offSnapshot();
    offUpdate();
    offStatus();
  });

  it("removes event listeners idempotently", () => {
    const callback = vi.fn();
    const off = lighterTrading.onCandleUpdate(callback);
    off();
    off();
    emit(EV.lighterTrading.candleUpdate, event);
    expect(callback).not.toHaveBeenCalled();
  });

  it("validates public market subscriptions and every sanitized push surface", async () => {
    const publicInput = {
      subscriptionId,
      environment: "rhc" as const,
      marketId: 7,
      marketType: "perp" as const,
    };
    await lighterTrading.startPublicMarketSubscription(publicInput);
    await lighterTrading.stopPublicMarketSubscription({ subscriptionId });
    expect(invoke).toHaveBeenCalledWith(
      CH.lighterTrading.startPublicMarketSubscription,
      expect.objectContaining({ payload: publicInput }),
    );

    const onBook = vi.fn();
    const onTrades = vi.fn();
    const onStats = vi.fn();
    const onStatus = vi.fn();
    lighterTrading.onPublicBook(onBook);
    lighterTrading.onPublicTrades(onTrades);
    lighterTrading.onPublicStats(onStats);
    lighterTrading.onPublicMarketStatus(onStatus);
    const base = {
      ...publicInput,
      status: "live",
      providerTimestamp: 1_787_530_000_000,
      receivedAt: 1_787_530_000_050,
    };
    emit(EV.lighterTrading.publicBook, {
      ...base,
      nonce: "10",
      book: { asks: [{ price: "4201", size: "2" }], bids: [] },
    });
    emit(EV.lighterTrading.publicTrades, {
      ...base,
      nonce: "11",
      trades: [{
        tradeId: "90071992547409939999",
        type: "trade",
        price: "4200",
        size: "0.1",
        usdAmount: "420",
        takerSide: "buy",
        timestamp: 1_787_530_000_000,
      }],
    });
    emit(EV.lighterTrading.publicStats, {
      ...base,
      stats: {
        lastTradePrice: 4_200,
        indexPrice: 4_201,
        markPrice: 4_200.5,
        midPrice: 4_200.25,
        bestAskPrice: 4_200.3,
        bestBidPrice: 4_200.2,
        openInterestQuote: 159_467_961.6831,
        daily: {
          baseTokenVolume: 30,
          quoteTokenVolume: 126_000,
          priceLow: 4_000,
          priceHigh: 4_300,
          priceChange: 1.2,
        },
        funding: {
          clampSmall: null,
          clampBig: null,
          baseInterestRate: null,
          currentRate: "0.0012",
          lastRate: "0.0011",
          timestamp: 1_787_526_400_000,
          premium: "0.0219",
        },
      },
    });
    emit(EV.lighterTrading.publicMarketStatus, {
      ...base,
      status: "delayed",
      providerTimestamp: null,
      bookStatus: "delayed",
      tradesStatus: "live",
      statsStatus: "live",
    });
    emit(EV.lighterTrading.publicBook, {
      ...base,
      nonce: "12",
      book: { asks: [{ price: "4201", size: "2", owner: "secret" }], bids: [] },
    });

    expect(onBook).toHaveBeenCalledOnce();
    expect(onTrades).toHaveBeenCalledOnce();
    expect(onStats).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenCalledOnce();
  });
});
