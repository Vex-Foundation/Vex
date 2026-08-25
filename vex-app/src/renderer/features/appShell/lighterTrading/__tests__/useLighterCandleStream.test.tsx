import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LighterTradingCandleSnapshotEvent,
  LighterTradingCandleStatusEvent,
  LighterTradingCandleUpdateEvent,
  LighterTradingStreamCandle,
} from "@shared/schemas/lighter-trading.js";
import { useLighterCandleStream } from "../useLighterCandleStream.js";

const callbacks: {
  snapshot: Array<(event: LighterTradingCandleSnapshotEvent) => void>;
  update: Array<(event: LighterTradingCandleUpdateEvent) => void>;
  status: Array<(event: LighterTradingCandleStatusEvent) => void>;
} = { snapshot: [], update: [], status: [] };

const start = vi.fn(async (input: {
  readonly subscriptionId: string;
  readonly environment: "rhc";
  readonly marketId: number;
  readonly resolution: "5m";
}) => ({ ok: true as const, data: { ...input, status: "started" as const } }));
const stop = vi.fn(async ({ subscriptionId }: { readonly subscriptionId: string }) => ({
  ok: true as const,
  data: { subscriptionId, status: "stopped" as const },
}));

beforeEach(() => {
  callbacks.snapshot.length = 0;
  callbacks.update.length = 0;
  callbacks.status.length = 0;
  start.mockClear();
  stop.mockClear();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      lighterTrading: {
        startCandleSubscription: start,
        stopCandleSubscription: stop,
        onCandleSnapshot: (callback: (event: LighterTradingCandleSnapshotEvent) => void) => {
          callbacks.snapshot.push(callback);
          return () => callbacks.snapshot.splice(callbacks.snapshot.indexOf(callback), 1);
        },
        onCandleUpdate: (callback: (event: LighterTradingCandleUpdateEvent) => void) => {
          callbacks.update.push(callback);
          return () => callbacks.update.splice(callbacks.update.indexOf(callback), 1);
        },
        onCandleStatus: (callback: (event: LighterTradingCandleStatusEvent) => void) => {
          callbacks.status.push(callback);
          return () => callbacks.status.splice(callbacks.status.indexOf(callback), 1);
        },
      },
    },
  });
});

describe("useLighterCandleStream", () => {
  it("merges newer provider ids, rejects regressions, and tears down its exact subscription", async () => {
    const original = streamCandle({ lastTradeId: "90071992547409930", close: 101 });
    const { result, unmount } = renderHook(() => useLighterCandleStream({
      enabled: true,
      environment: "rhc",
      marketId: 10,
      resolution: "5m",
      restCandles: [original],
    }));

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const subscriptionId = start.mock.calls[0]![0].subscriptionId;
    act(() => callbacks.update[0]?.(updateEvent(subscriptionId, [
      streamCandle({ lastTradeId: "90071992547409931", close: 102 }),
    ])));
    expect(result.current.candles.at(-1)?.close).toBe(102);
    expect(result.current.status).toBe("live");
    expect(result.current.receivedAt).toBe(1_720_000_001_000);

    act(() => callbacks.update[0]?.(updateEvent(subscriptionId, [
      streamCandle({ lastTradeId: "90071992547409929", close: 99 }),
    ], 1_720_000_099_000)));
    expect(result.current.candles.at(-1)?.close).toBe(102);
    expect(result.current.receivedAt).toBe(1_720_000_001_000);

    act(() => callbacks.update[0]?.(updateEvent(crypto.randomUUID(), [
      streamCandle({ lastTradeId: "90071992547409999", close: 999 }),
    ])));
    expect(result.current.candles.at(-1)?.close).toBe(102);

    unmount();
    expect(stop).toHaveBeenCalledWith({ subscriptionId });
    expect(callbacks.snapshot).toHaveLength(0);
    expect(callbacks.update).toHaveLength(0);
    expect(callbacks.status).toHaveLength(0);
  });

  it("surfaces provider connection states independently of REST retrieval time", async () => {
    const { result } = renderHook(() => useLighterCandleStream({
      enabled: true,
      environment: "rhc",
      marketId: 10,
      resolution: "5m",
      restCandles: [],
    }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const subscriptionId = start.mock.calls[0]![0].subscriptionId;

    act(() => callbacks.status[0]?.({
      subscriptionId,
      environment: "rhc",
      marketId: 10,
      resolution: "5m",
      providerTimestamp: null,
      receivedAt: 1_720_000_001_000,
      status: "reconnecting",
      candles: [],
    }));

    expect(result.current.status).toBe("reconnecting");
    expect(result.current.providerTimestamp).toBeNull();
    expect(result.current.receivedAt).toBeNull();
  });
});

function streamCandle(
  overrides: Partial<LighterTradingStreamCandle> = {},
): LighterTradingStreamCandle {
  return {
    timestamp: 1_720_000_000_000,
    open: 100,
    high: 103,
    low: 99,
    close: 101,
    volumeBase: 3,
    volumeQuote: 303,
    lastTradeId: "1",
    providerResolution: "5m",
    source: "websocket_update",
    ...overrides,
  };
}

function updateEvent(
  subscriptionId: string,
  candles: LighterTradingStreamCandle[],
  receivedAt = 1_720_000_001_000,
): LighterTradingCandleUpdateEvent {
  return {
    subscriptionId,
    environment: "rhc",
    marketId: 10,
    resolution: "5m",
    providerTimestamp: candles.at(-1)?.timestamp ?? 0,
    receivedAt,
    status: "live",
    candles,
  };
}
