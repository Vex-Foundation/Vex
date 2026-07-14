import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HyperliquidCandleUpdateEvent,
  HyperliquidMidsUpdateEvent,
} from "@shared/schemas/hyperliquid.js";
import type {
  HyperliquidLiveClient,
  HyperliquidLiveSubscription,
  HyperliquidLiveTransport,
} from "../hyperliquid-live-feed-service.js";

vi.mock("../../lifecycle/broadcast.js", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { setupHyperliquidLiveFeedService } = await import("../hyperliquid-live-feed-service.js");
const { log } = await import("../../logger/index.js");

type CandleListener = (event: unknown) => void;
type MidsListener = (event: unknown) => void;
type SubError = (cause: unknown) => void;

interface FakeSubscription extends HyperliquidLiveSubscription {
  readonly unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

interface CandleCall {
  readonly params: { readonly coin: string; readonly interval: string };
  readonly listener: CandleListener;
  readonly onError: SubError;
  readonly sub: FakeSubscription;
}

interface MidsCall {
  readonly listener: MidsListener;
  readonly onError: SubError;
  readonly sub: FakeSubscription;
}

function fakeSubscription(): FakeSubscription {
  return { unsubscribe: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
}

class FakeTransport implements HyperliquidLiveTransport {
  closed = false;
  readonly candleCalls: CandleCall[] = [];
  readonly midsCalls: MidsCall[] = [];

  readonly client: HyperliquidLiveClient = {
    candle: (params, listener, options) => {
      const sub = fakeSubscription();
      this.candleCalls.push({ params, listener, onError: options.onError, sub });
      return Promise.resolve(sub);
    },
    allMids: (listener, options) => {
      const sub = fakeSubscription();
      this.midsCalls.push({ listener, onError: options.onError, sub });
      return Promise.resolve(sub);
    },
  };

  close(): void {
    this.closed = true;
  }
}

function candleEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    t: 1_700_000_000_000,
    T: 1_700_000_060_000,
    s: "BTC",
    i: "1h",
    o: "100.10",
    h: "110",
    l: "90.0",
    c: "105.5",
    v: "12.000",
    n: 42,
    ...overrides,
  };
}

interface Harness {
  readonly transports: FakeTransport[];
  readonly publishCandle: ReturnType<typeof vi.fn>;
  readonly publishMids: ReturnType<typeof vi.fn>;
}

function setup(): { controller: ReturnType<typeof setupHyperliquidLiveFeedService>; h: Harness } {
  const transports: FakeTransport[] = [];
  const publishCandle = vi.fn<(event: HyperliquidCandleUpdateEvent) => void>();
  const publishMids = vi.fn<(event: HyperliquidMidsUpdateEvent) => void>();
  const controller = setupHyperliquidLiveFeedService({
    createTransport: () => {
      const t = new FakeTransport();
      transports.push(t);
      return t;
    },
    publishCandle,
    publishMids,
    midsThrottleMs: 500,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 30_000,
  });
  return { controller, h: { transports, publishCandle, publishMids } };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("hyperliquid live feed — refcount + teardown", () => {
  it("shares one SDK candle subscription across two watchers of the same (coin, interval)", async () => {
    const { controller, h } = setup();
    const w1 = await controller.watch(1, "BTC", "1h");
    const w2 = await controller.watch(1, "BTC", "1h");

    expect(h.transports).toHaveLength(1);
    expect(h.transports[0]?.candleCalls).toHaveLength(1);
    expect(h.transports[0]?.candleCalls[0]?.params).toEqual({ coin: "BTC", interval: "1h" });

    // Releasing one watcher keeps the shared subscription and transport alive.
    expect(await controller.unwatch(1, w1)).toBe(true);
    expect(h.transports[0]?.candleCalls[0]?.sub.unsubscribe).not.toHaveBeenCalled();
    expect(h.transports[0]?.closed).toBe(false);

    // Releasing the last watcher unsubscribes and tears the transport down.
    expect(await controller.unwatch(1, w2)).toBe(true);
    expect(h.transports[0]?.candleCalls[0]?.sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.transports[0]?.closed).toBe(true);
  });

  it("distinct (coin, interval) get distinct subscriptions; last release closes the transport", async () => {
    const { controller, h } = setup();
    await controller.watch(1, "BTC", "1h");
    await controller.watch(1, "ETH", "1h");

    expect(h.transports).toHaveLength(1);
    expect(h.transports[0]?.candleCalls).toHaveLength(2);
    // allMids is subscribed exactly once while any watch exists.
    expect(h.transports[0]?.midsCalls).toHaveLength(1);

    await controller.releaseOwner(1);
    expect(h.transports[0]?.closed).toBe(true);
    expect(h.transports[0]?.midsCalls[0]?.sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("releaseOwner releases every watch that a webContents holds", async () => {
    const { controller, h } = setup();
    await controller.watch(7, "BTC", "1h");
    await controller.watch(7, "SOL", "15m");
    await controller.watch(9, "ETH", "1h"); // a different owner keeps the feed alive

    await controller.releaseOwner(7);

    // Owner 9 still watches, so the transport stays open.
    expect(h.transports[0]?.closed).toBe(false);
    await controller.releaseOwner(9);
    expect(h.transports[0]?.closed).toBe(true);
  });

  it("only the owning webContents may release a watch id", async () => {
    const { controller } = setup();
    const w1 = await controller.watch(1, "BTC", "1h");
    expect(await controller.unwatch(2, w1)).toBe(false);
    expect(await controller.unwatch(1, w1)).toBe(true);
  });
});

describe("hyperliquid live feed — candle mapping", () => {
  it("maps a WS candle tick into a canonicalized candleUpdate payload", async () => {
    const { controller, h } = setup();
    await controller.watch(1, "BTC", "1h");
    const listener = h.transports[0]?.candleCalls[0]?.listener;
    expect(listener).toBeDefined();

    listener?.(candleEvent());

    expect(h.publishCandle).toHaveBeenCalledTimes(1);
    expect(h.publishCandle).toHaveBeenCalledWith({
      coin: "BTC",
      interval: "1h",
      candle: {
        openTimeMs: 1_700_000_000_000,
        open: "100.1",
        high: "110",
        low: "90",
        close: "105.5",
        volume: "12",
      },
    });
  });

  it("drops a malformed candle without throwing or affecting a healthy watch", async () => {
    const { controller, h } = setup();
    await controller.watch(1, "BTC", "1h");
    await controller.watch(1, "ETH", "1h");
    const btc = h.transports[0]?.candleCalls[0];
    const eth = h.transports[0]?.candleCalls[1];

    // Missing OHLC field + negative price are both rejected/dropped.
    expect(() => btc?.listener({ t: 1, o: "1" })).not.toThrow();
    expect(() => btc?.listener(candleEvent({ o: "-5" }))).not.toThrow();
    expect(h.publishCandle).not.toHaveBeenCalled();

    // The other watch still publishes normally.
    eth?.listener(candleEvent({ s: "ETH", i: "1h" }));
    expect(h.publishCandle).toHaveBeenCalledTimes(1);
    expect(h.publishCandle).toHaveBeenCalledWith(expect.objectContaining({ coin: "ETH" }));
  });
});

describe("hyperliquid live feed — mids filtering + coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters allMids to watched coins and never forwards the full map", async () => {
    const { controller, h } = setup();
    await controller.watch(1, "BTC", "1h");
    const midsListener = h.transports[0]?.midsCalls[0]?.listener;
    expect(midsListener).toBeDefined();

    midsListener?.({ mids: { BTC: "100000", ETH: "3000", SOL: "150" } });

    expect(h.publishMids).toHaveBeenCalledTimes(1);
    expect(h.publishMids).toHaveBeenCalledWith({ mids: [{ coin: "BTC", midPx: "100000" }] });
  });

  it("coalesces a burst to at most one leading + one trailing push per window", async () => {
    const { controller, h } = setup();
    await controller.watch(1, "BTC", "1h");
    const midsListener = h.transports[0]?.midsCalls[0]?.listener;

    for (let i = 0; i < 5; i += 1) {
      midsListener?.({ mids: { BTC: `${100_000 + i}` } });
    }
    // Leading push fired immediately; the rest coalesced into one trailing push.
    expect(h.publishMids).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(h.publishMids).toHaveBeenCalledTimes(2);
    // The trailing push carries the most recent mid.
    expect(h.publishMids).toHaveBeenLastCalledWith({ mids: [{ coin: "BTC", midPx: "100004" }] });
  });

  it("drops a malformed mids payload", async () => {
    const { controller, h } = setup();
    await controller.watch(1, "BTC", "1h");
    const midsListener = h.transports[0]?.midsCalls[0]?.listener;

    expect(() => midsListener?.({ notMids: true })).not.toThrow();
    expect(h.publishMids).not.toHaveBeenCalled();
  });
});

describe("hyperliquid live feed — reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs once and rebuilds the transport with backoff on a permanent subscription error", async () => {
    const { controller, h } = setup();
    await controller.watch(1, "BTC", "1h");
    expect(h.transports).toHaveLength(1);

    // Simulate the SDK reporting a permanent subscription failure.
    h.transports[0]?.candleCalls[0]?.onError(new Error("connection permanently terminated"));
    expect(log.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    // A fresh transport is built and the active candle subscription re-created.
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]?.closed).toBe(true);
    expect(h.transports[1]?.candleCalls).toHaveLength(1);
    expect(h.transports[1]?.candleCalls[0]?.params).toEqual({ coin: "BTC", interval: "1h" });
  });
});
