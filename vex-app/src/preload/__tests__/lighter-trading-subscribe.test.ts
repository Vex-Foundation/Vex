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
});
