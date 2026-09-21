import { requireValue } from "../../../../../../../src/__tests__/helpers/require-value.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type {
  LighterTradingCandleHistory,
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
interface HistoryInvocation {
  readonly cancel: () => void;
  readonly promise: Promise<Result<LighterTradingCandleHistory>>;
}

const history = vi.fn((input: { readonly endTimestamp: number; readonly count: number }): HistoryInvocation => ({
  cancel: vi.fn(),
  promise: Promise.resolve({
    ok: true as const,
    data: {
      environment: "rhc" as const,
      marketId: 10,
      resolution: "5m" as const,
      retrievedAt: 1_720_000_002_000,
      candles: input.endTimestamp < 1_719_999_000_000 ? [] : [
        streamCandle({ timestamp: 1_719_999_700_000, low: 89, close: 90, lastTradeId: undefined, source: "rest_snapshot" }),
        streamCandle({ timestamp: 1_720_000_000_000, close: 100, lastTradeId: undefined, source: "rest_snapshot" }),
      ],
    },
  }),
}));

beforeEach(() => {
  callbacks.snapshot.length = 0;
  callbacks.update.length = 0;
  callbacks.status.length = 0;
  start.mockClear();
  stop.mockClear();
  history.mockClear();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      lighterTrading: {
        startCandleSubscription: start,
        stopCandleSubscription: stop,
        getCandleHistory: history,
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
    const subscriptionId = requireValue(start.mock.calls[0])[0].subscriptionId;
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

  it("pages older history from the earliest bar, dedupes in-flight reads, and marks exhaustion", async () => {
    // Stable seed rows: the hook re-merges `restCandles` whenever the array identity changes.
    const seed = [streamCandle({ lastTradeId: undefined, source: "rest_snapshot" })];
    const { result } = renderHook(() => useLighterCandleStream({
      enabled: true,
      environment: "rhc",
      marketId: 10,
      resolution: "5m",
      restCandles: seed,
    }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(result.current.history).toBe("idle");

    act(() => { result.current.loadOlder(); result.current.loadOlder(); });
    expect(history).toHaveBeenCalledTimes(1);
    expect(requireValue(history.mock.calls[0])[0]).toMatchObject({ endTimestamp: 1_719_999_999_999, count: 500 });
    expect(result.current.history).toBe("loading");

    await waitFor(() => expect(result.current.history).toBe("idle"));
    expect(result.current.candles.map((candle) => candle.close)).toEqual([90, 101]);

    act(() => { result.current.loadOlder(); });
    await waitFor(() => expect(result.current.history).toBe("exhausted"));
    expect(history).toHaveBeenCalledTimes(2);
    act(() => { result.current.loadOlder(); });
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("keeps paging after a failed read and after a page the chart has not rendered yet", async () => {
    const seed = [streamCandle({ timestamp: 1_720_000_600_000, lastTradeId: undefined, source: "rest_snapshot" })];
    history.mockImplementationOnce((): HistoryInvocation => ({
      cancel: vi.fn(),
      promise: Promise.resolve({
        ok: false,
        error: { code: "provider.unavailable", domain: "market", message: "Live Lighter market data is temporarily unavailable.", retryable: true, userActionable: true, redacted: true, correlationId: "11111111-2222-3333-4444-555555555555" },
      }),
    }));
    const { result } = renderHook(() => useLighterCandleStream({
      enabled: true,
      environment: "rhc",
      marketId: 10,
      resolution: "5m",
      restCandles: seed,
    }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    // A provider failure is not a history boundary: the next scroll retries it.
    act(() => { result.current.loadOlder(); });
    await waitFor(() => expect(result.current.history).toBe("idle"));
    expect(history).toHaveBeenCalledTimes(1);

    act(() => { result.current.loadOlder(); });
    await waitFor(() => expect(result.current.history).toBe("idle"));
    expect(history).toHaveBeenCalledTimes(2);
    expect(result.current.candles.map((candle) => candle.timestamp)).toEqual([
      1_719_999_700_000,
      1_720_000_000_000,
      1_720_000_600_000,
    ]);
  });

  it("anchors the next page on the applied page, not on the next render", async () => {
    const seed = [streamCandle({ timestamp: 1_720_000_600_000, lastTradeId: undefined, source: "rest_snapshot" })];
    const { result } = renderHook(() => useLighterCandleStream({
      enabled: true,
      environment: "rhc",
      marketId: 10,
      resolution: "5m",
      restCandles: seed,
    }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    // The chart can scroll again between a page landing and React re-rendering.
    // The second request must start below the page that just landed.
    await act(async () => {
      result.current.loadOlder();
      await Promise.resolve();
      await Promise.resolve();
      result.current.loadOlder();
    });
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    expect(requireValue(history.mock.calls[1])[0]).toMatchObject({ endTimestamp: 1_719_999_699_999 });
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
    const subscriptionId = requireValue(start.mock.calls[0])[0].subscriptionId;

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
