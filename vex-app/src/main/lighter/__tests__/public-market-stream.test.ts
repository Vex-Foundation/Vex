import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS,
  LIGHTER_PUBLIC_MARKET_STALE_AFTER_MS,
  LighterPublicMarketSupervisor,
  type LighterPublicMarketSocket,
  type LighterPublicMarketStreamEvent,
  type LighterPublicMarketSupervisorDeps,
} from "../public-market-stream.js";

const SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000731";
const NOW = 1_787_651_803_580;

class FakeSocket implements LighterPublicMarketSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit("close", { code, reason });
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: "open" | "message" | "close" | "error", event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  rawMessage(value: string): void {
    this.emit("message", { data: value });
  }
}

function makeHarness() {
  const sockets: FakeSocket[] = [];
  const events: LighterPublicMarketStreamEvent[] = [];
  const diagnostics: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const deps: LighterPublicMarketSupervisorDeps = {
    createSocket: vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
    now: Date.now,
    random: () => 0,
    diagnostic: (event, detail) => diagnostics.push({ event, detail: { ...detail } }),
  };
  const supervisor = new LighterPublicMarketSupervisor(deps);
  return { supervisor, deps, sockets, events, diagnostics };
}

async function connect(
  harness: ReturnType<typeof makeHarness>,
  marketType: "perp" | "spot" = "perp",
  marketId = marketType === "perp" ? 1 : 2_057,
): Promise<FakeSocket> {
  harness.supervisor.subscribe(
    51,
    { subscriptionId: SUBSCRIPTION_ID, environment: "core", marketId, marketType },
    (event) => harness.events.push(event),
  );
  await vi.advanceTimersByTimeAsync(0);
  const socket = harness.sockets[0]!;
  const channels = socket.sent.map((value) => JSON.parse(value) as { channel: string });
  expect(channels).toEqual(expect.arrayContaining([
    { type: "subscribe", channel: `order_book/${marketId}` },
    { type: "subscribe", channel: `trade/${marketId}` },
    {
      type: "subscribe",
      channel: `${marketType === "spot" ? "spot_market_stats" : "market_stats"}/${marketId}`,
    },
  ]));
  return socket;
}

function bookFrame({
  type = "subscribed/order_book",
  marketId = 1,
  nonce = "20128432629",
  beginNonce = "0",
  asks = [{ price: "79203.7", size: "3.20277" }],
  bids = [{ price: "79203.6", size: "0.60924" }],
}: {
  readonly type?: "subscribed/order_book" | "update/order_book";
  readonly marketId?: number;
  readonly nonce?: string;
  readonly beginNonce?: string;
  readonly asks?: ReadonlyArray<{ readonly price: string; readonly size: string }>;
  readonly bids?: ReadonlyArray<{ readonly price: string; readonly size: string }>;
} = {}) {
  return {
    type,
    channel: `order_book:${marketId}`,
    timestamp: NOW,
    order_book: { code: 0, asks, bids, nonce, begin_nonce: beginNonce },
  };
}

function perpStatsFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: "subscribed/market_stats",
    channel: "market_stats:1",
    timestamp: NOW + 50,
    market_stats: {
      symbol: "BTC",
      market_id: 1,
      index_price: "79224.3",
      mark_price: "79230",
      mid_price: "79202.3",
      best_ask_price: "79203.7",
      best_bid_price: "79200.9",
      open_interest: "159467961.683100",
      last_trade_price: "79200.9",
      current_funding_rate: "0.0012",
      funding_rate: "0.0011",
      funding_timestamp: NOW - 3_600_000,
      daily_base_token_volume: 25_975.99979,
      daily_quote_token_volume: 2_069_816_818.421142,
      daily_price_low: 77_489.9,
      daily_price_high: 81_360.4,
      daily_price_change: 1.9552576278868539,
      premium: "0.0219",
      ...overrides,
    },
  };
}

function spotStatsFrame() {
  return {
    type: "subscribed/spot_market_stats",
    channel: "spot_market_stats:2057",
    timestamp: NOW + 50,
    spot_market_stats: {
      symbol: "rhSPY/USDC",
      market_id: 2_057,
      index_price: "767.705000",
      mid_price: "768.31",
      last_trade_price: "766.07",
      daily_base_token_volume: 3.2717,
      daily_quote_token_volume: 2_500.405934,
      daily_price_low: 763.79,
      daily_price_high: 766.07,
      daily_price_change: 0.0862282959459636,
    },
  };
}

function trade(index: number) {
  return {
    trade_id_str: String(28_420_958_700 + index),
    type: "trade",
    market_id: 1,
    size: "0.00017",
    price: "79203.7",
    usd_amount: "13.464629",
    is_maker_ask: index % 2 === 0,
    timestamp: NOW + index,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Lighter public market stream", () => {
  it("accepts official subscribed perp frames, caps large trade snapshots, and keeps OI quote-notional", async () => {
    const h = makeHarness();
    const socket = await connect(h);

    socket.message(bookFrame({
      asks: [
        { price: "9007199254740993.10", size: "1" },
        { price: "9007199254740993.2", size: "2" },
      ],
    }));
    socket.message({
      type: "subscribed/trade",
      channel: "trade:1",
      nonce: "20128432680",
      trades: Array.from({ length: 50 }, (_, index) => trade(index)),
      liquidation_trades: Array.from({ length: 50 }, (_, index) => ({
        ...trade(index + 50),
        type: "liquidation",
      })),
    });
    // Deliberately omit clamp/base-interest fields: they are not required for
    // the current public stats product and must not block valid live stats.
    socket.message(perpStatsFrame());

    const book = h.events.find((event) => event.kind === "book");
    expect(book?.kind === "book" && book.book.asks.map((row) => row.price)).toEqual([
      "9007199254740993.10",
      "9007199254740993.2",
    ]);
    const trades = h.events.find((event) => event.kind === "trades");
    expect(trades?.kind === "trades" && trades.trades).toHaveLength(40);
    const stats = h.events.find((event) => event.kind === "stats");
    expect(stats?.kind === "stats" && stats.stats).toMatchObject({
      openInterestQuote: 159_467_961.6831,
      markPrice: 79_230,
      funding: { currentRate: "0.0012", lastRate: "0.0011" },
    });
    expect(h.events).toContainEqual(expect.objectContaining({
      kind: "status",
      status: "live",
      bookStatus: "live",
      statsStatus: "live",
      tradesStatus: "live",
    }));
    h.supervisor.stop();
  });

  it("replaces subscribed books, applies exact-price deltas, and closes on a forward nonce gap", async () => {
    const h = makeHarness();
    const socket = await connect(h);
    socket.message(bookFrame({
      asks: [{ price: "101.10", size: "2" }],
      bids: [{ price: "100.90", size: "3" }],
    }));
    socket.message(perpStatsFrame());
    h.events.length = 0;

    socket.message(bookFrame({
      type: "update/order_book",
      nonce: "20128432675",
      beginNonce: "20128432629",
      asks: [{ price: "101.10", size: "0.00000" }, { price: "101.20", size: "4" }],
      bids: [],
    }));
    const update = h.events.find((event) => event.kind === "book");
    expect(update?.kind === "book" && update.book.asks).toEqual([
      { price: "101.20", size: "4" },
    ]);

    socket.message(bookFrame({
      type: "update/order_book",
      nonce: "20128432700",
      beginNonce: "20128432674",
    }));
    expect(socket.closes.at(-1)?.reason).toBe("order_book_gap");
    expect(h.events).toContainEqual(expect.objectContaining({
      kind: "status",
      status: "delayed",
      bookStatus: "delayed",
      statsStatus: "live",
    }));
    h.supervisor.stop();
  });

  it("accepts official spot stats without perp-only fields or undocumented spot BBO", async () => {
    const h = makeHarness();
    const socket = await connect(h, "spot", 2_057);
    socket.message(bookFrame({ marketId: 2_057, asks: [], bids: [] }));
    socket.message({
      type: "subscribed/trade",
      channel: "trade:2057",
      nonce: "10",
      trades: [],
      liquidation_trades: [],
    });
    socket.message(spotStatsFrame());

    const stats = h.events.find((event) => event.kind === "stats");
    expect(stats?.kind === "stats" && stats.stats).toMatchObject({
      markPrice: null,
      bestAskPrice: null,
      bestBidPrice: null,
      openInterestQuote: null,
      funding: { currentRate: null, premium: null },
    });
    expect(h.events).toContainEqual(expect.objectContaining({
      kind: "status",
      status: "live",
    }));
    expect(socket.closes).toEqual([]);
    h.supervisor.stop();
  });

  it("accepts an active empty perp book, empty trade snapshot, and nullable mid/BBO", async () => {
    const h = makeHarness();
    const socket = await connect(h);
    socket.message(bookFrame({ nonce: "0", asks: [], bids: [] }));
    socket.message({
      type: "subscribed/trade",
      channel: "trade:1",
      nonce: "0",
      trades: [],
      liquidation_trades: [],
    });
    socket.message(perpStatsFrame({
      mid_price: "",
      best_ask_price: "",
      best_bid_price: "",
    }));

    const book = h.events.find((event) => event.kind === "book");
    expect(book?.kind === "book" && book.book).toEqual({ asks: [], bids: [] });
    const stats = h.events.find((event) => event.kind === "stats");
    expect(stats?.kind === "stats" && stats.stats).toMatchObject({
      midPrice: null,
      bestAskPrice: null,
      bestBidPrice: null,
    });
    expect(h.events.filter((event) => event.kind === "trades")).toEqual([]);
    expect(h.events).toContainEqual(expect.objectContaining({ kind: "status", status: "live" }));
    expect(socket.closes).toEqual([]);
    h.supervisor.stop();
  });

  it("does not let a busy book hide frozen stats", async () => {
    const h = makeHarness();
    const socket = await connect(h);
    socket.message(bookFrame());
    socket.message(perpStatsFrame());
    h.events.length = 0;

    let nonce = 20_128_432_629n;
    for (let elapsed = LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS;
      elapsed <= LIGHTER_PUBLIC_MARKET_STALE_AFTER_MS + LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS;
      elapsed += LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS) {
      await vi.advanceTimersByTimeAsync(LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS);
      const previous = nonce;
      nonce += 1n;
      if (elapsed <= LIGHTER_PUBLIC_MARKET_STALE_AFTER_MS) {
        socket.message(bookFrame({
          type: "update/order_book",
          beginNonce: previous.toString(),
          nonce: nonce.toString(),
        }));
      }
    }

    expect(h.events).toContainEqual(expect.objectContaining({
      kind: "status",
      status: "delayed",
      bookStatus: "live",
      statsStatus: "delayed",
    }));
    h.supervisor.stop();
  });

  it("does not let active stats hide a frozen book", async () => {
    const h = makeHarness();
    const socket = await connect(h);
    socket.message(bookFrame());
    socket.message(perpStatsFrame());
    h.events.length = 0;

    for (let elapsed = LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS;
      elapsed <= LIGHTER_PUBLIC_MARKET_STALE_AFTER_MS + LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS;
      elapsed += LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS) {
      await vi.advanceTimersByTimeAsync(LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS);
      if (elapsed <= LIGHTER_PUBLIC_MARKET_STALE_AFTER_MS) {
        socket.message({
          ...perpStatsFrame(),
          type: "update/market_stats",
          timestamp: NOW + elapsed,
        });
      }
    }

    expect(h.events).toContainEqual(expect.objectContaining({
      kind: "status",
      status: "delayed",
      bookStatus: "delayed",
      statsStatus: "live",
    }));
    h.supervisor.stop();
  });
});
