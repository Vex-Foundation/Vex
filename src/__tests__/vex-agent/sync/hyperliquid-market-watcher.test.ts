import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseHlMarkPriceWatchCondition,
  reconcileHyperliquidCandleSubscriptions,
  registerHyperliquidMarkPriceWatchEvaluator,
  tickHyperliquidMarketWatcher,
} from "../../../vex-agent/sync/hyperliquid-market-watcher.js";

describe("Hyperliquid mark-price watch boundary", () => {
  it("accepts canonical trigger prices and rejects non-canonical financial strings", () => {
    expect(parseHlMarkPriceWatchCondition({ type: "hl_mark_price", coin: "BTC", direction: "above", price: "100" }))
      .toMatchObject({ price: "100" });
    for (const price of ["1.50", "1e2", "-0"]) {
      expect(() => parseHlMarkPriceWatchCondition({ type: "hl_mark_price", coin: "BTC", direction: "above", price }))
        .toThrow();
    }
  });
});

describe("Hyperliquid mark-price watcher", () => {
  const getPendingWithWatch = vi.fn();
  const promotePendingWake = vi.fn();
  const createInfoClient = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    registerHyperliquidMarkPriceWatchEvaluator();
  });

  it("promotes a matching pending wake once and never postpones it", async () => {
    getPendingWithWatch.mockResolvedValue([{
      id: "wake-1", sessionId: "session-1", missionRunId: "run-1", dueAt: "2026-07-11T12:00:00.000Z",
      status: "pending", reason: "watch", payload: {
        watchId: "watch-1", watchVersion: 1,
        conditions: [{ type: "hl_mark_price", coin: "BTC", direction: "above", price: "100" }],
      }, createdAt: "2026-07-11T11:00:00.000Z", consumedAt: null, cancelledAt: null, cancelledReason: null,
    }]);
    createInfoClient.mockReturnValue({ allMids: vi.fn().mockResolvedValue({ BTC: "100.0" }) });
    promotePendingWake.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const deps = {
      createInfoClient,
      getOpenPositions: vi.fn(),
      getPendingWithWatch,
      promotePendingWake,
    };

    expect(await tickHyperliquidMarketWatcher(deps)).toEqual({ checked: 1, promoted: 1 });
    expect(await tickHyperliquidMarketWatcher(deps)).toEqual({ checked: 1, promoted: 0 });
    expect(promotePendingWake).toHaveBeenCalledWith("session-1", "run-1", "watch-1");
  });

  it("short-circuits when no watch survives position/order cleanup", async () => {
    getPendingWithWatch.mockResolvedValue([]);
    const deps = {
      createInfoClient,
      getOpenPositions: vi.fn(),
      getPendingWithWatch,
      promotePendingWake,
    };
    await expect(tickHyperliquidMarketWatcher(deps)).resolves.toEqual({ checked: 0, promoted: 0 });
    expect(createInfoClient).not.toHaveBeenCalled();
  });
});

describe("Hyperliquid candle subscription reconciliation", () => {
  it("resubscribes persisted enabled pairs on boot and stops disabled pairs", async () => {
    const starts = vi.fn(async () => undefined);
    const stops = vi.fn(async () => undefined);
    const subscriptions = new Map<string, { start: () => Promise<void>; stop: () => Promise<void> }>();
    const listEnabledCandleWatches = vi.fn(async () => [{ coin: "BTC", interval: "1h" as const, enabled: true, updatedAt: "2026-07-12T00:00:00.000Z" }]);
    const createCandleSubscriptions = vi.fn(() => ({ start: starts, stop: stops }));

    await reconcileHyperliquidCandleSubscriptions({ listEnabledCandleWatches, createCandleSubscriptions } as never, subscriptions as never);
    expect(createCandleSubscriptions).toHaveBeenCalledWith(expect.objectContaining({ coin: "BTC", interval: "1h" }));
    expect(starts).toHaveBeenCalledTimes(1);

    listEnabledCandleWatches.mockResolvedValue([]);
    await reconcileHyperliquidCandleSubscriptions({ listEnabledCandleWatches, createCandleSubscriptions } as never, subscriptions as never);
    expect(stops).toHaveBeenCalledTimes(1);
    expect(subscriptions.size).toBe(0);
  });
});
