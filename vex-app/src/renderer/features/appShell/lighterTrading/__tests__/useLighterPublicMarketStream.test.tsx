import { requireValue } from "../../../../../../../src/__tests__/helpers/require-value.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LighterTradingPublicBookEvent,
  LighterTradingPublicMarketStatusEvent,
  LighterTradingPublicStatsEvent,
  LighterTradingPublicTradesEvent,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import {
  mergePublicTrades,
  useLighterPublicMarketStream,
} from "../useLighterPublicMarketStream.js";

const callbacks: {
  book: Array<(event: LighterTradingPublicBookEvent) => void>;
  trades: Array<(event: LighterTradingPublicTradesEvent) => void>;
  stats: Array<(event: LighterTradingPublicStatsEvent) => void>;
  status: Array<(event: LighterTradingPublicMarketStatusEvent) => void>;
} = { book: [], trades: [], stats: [], status: [] };

const start = vi.fn(async (input: {
  readonly subscriptionId: string;
  readonly environment: "core";
  readonly marketId: number;
  readonly marketType: "perp";
}) => ({ ok: true as const, data: { ...input, status: "started" as const } }));
const stop = vi.fn(async ({ subscriptionId }: { readonly subscriptionId: string }) => ({
  ok: true as const,
  data: { subscriptionId, status: "stopped" as const },
}));

const restTrade = trade("90071992547409931", 1_787_530_000_000);
const restSnapshot = {
  trades: [restTrade],
} as LighterTradingSnapshot;

beforeEach(() => {
  callbacks.book.length = 0;
  callbacks.trades.length = 0;
  callbacks.stats.length = 0;
  callbacks.status.length = 0;
  start.mockClear();
  stop.mockClear();
  const register = <T,>(list: Array<(event: T) => void>) => (callback: (event: T) => void) => {
    list.push(callback);
    return () => list.splice(list.indexOf(callback), 1);
  };
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      lighterTrading: {
        startPublicMarketSubscription: start,
        stopPublicMarketSubscription: stop,
        onPublicBook: register(callbacks.book),
        onPublicTrades: register(callbacks.trades),
        onPublicStats: register(callbacks.stats),
        onPublicMarketStatus: register(callbacks.status),
      },
    },
  });
});

describe("useLighterPublicMarketStream", () => {
  it("scopes live events to one market and keeps independent surface freshness", async () => {
    const { result, unmount } = renderHook(() => useLighterPublicMarketStream({
      enabled: true,
      environment: "core",
      marketId: 1,
      marketType: "perp",
      restSnapshot,
    }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const subscriptionId = requireValue(start.mock.calls[0])[0].subscriptionId;

    act(() => callbacks.book[0]?.(bookEvent(subscriptionId, 2)));
    act(() => callbacks.book[0]?.(bookEvent(crypto.randomUUID(), 999)));
    expect(result.current.book?.asks[0]?.size).toBe("2");
    expect(result.current.bookReceivedAt).toBe(1_787_530_000_100);

    act(() => callbacks.trades[0]?.(tradesEvent(subscriptionId, [
      trade("90071992547409932", 1_787_530_000_100),
    ])));
    expect(result.current.trades.map((row) => row.tradeId)).toEqual([
      "90071992547409932",
      "90071992547409931",
    ]);

    act(() => callbacks.status[0]?.({
      ...scope(subscriptionId),
      status: "delayed",
      bookStatus: "delayed",
      tradesStatus: "live",
      statsStatus: "live",
      providerTimestamp: null,
      receivedAt: 1_787_530_000_200,
    }));
    expect(result.current).toMatchObject({
      status: "delayed",
      bookStatus: "delayed",
      tradesStatus: "live",
      statsStatus: "live",
    });

    unmount();
    expect(stop).toHaveBeenCalledWith({ subscriptionId });
    expect(callbacks.book).toHaveLength(0);
    expect(callbacks.trades).toHaveLength(0);
    expect(callbacks.stats).toHaveLength(0);
    expect(callbacks.status).toHaveLength(0);
  });

  it("orders exact trade ids without Number coercion", () => {
    expect(mergePublicTrades(
      [trade("90071992547409931234567890", 10)],
      [trade("90071992547409931234567891", 10)],
    ).map((row) => row.tradeId)).toEqual([
      "90071992547409931234567891",
      "90071992547409931234567890",
    ]);
  });
});

function scope(subscriptionId: string) {
  return {
    subscriptionId,
    environment: "core" as const,
    marketId: 1,
    marketType: "perp" as const,
  };
}

function trade(tradeId: string, timestamp: number) {
  return {
    tradeId,
    type: "trade" as const,
    price: "4200",
    size: "0.1",
    usdAmount: "420",
    takerSide: "buy" as const,
    timestamp,
  };
}

function bookEvent(subscriptionId: string, size: number): LighterTradingPublicBookEvent {
  return {
    ...scope(subscriptionId),
    status: "live",
    providerTimestamp: 1_787_530_000_000,
    receivedAt: 1_787_530_000_100,
    nonce: "10",
    book: {
      asks: [{ price: "4201", size: String(size) }],
      bids: [{ price: "4199", size: "1" }],
    },
  };
}

function tradesEvent(
  subscriptionId: string,
  trades: LighterTradingPublicTradesEvent["trades"],
): LighterTradingPublicTradesEvent {
  return {
    ...scope(subscriptionId),
    status: "live",
    providerTimestamp: trades[0]?.timestamp ?? 0,
    receivedAt: 1_787_530_000_100,
    nonce: "11",
    trades,
  };
}
