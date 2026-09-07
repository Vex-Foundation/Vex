import { requireValue } from "../../../../../src/__tests__/helpers/require-value.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterCandleTarget, LighterInternalCandle } from "../trading-panel-service.js";
import {
  LIGHTER_CANDLE_STREAM_KEEPALIVE_INTERVAL_MS,
  LIGHTER_CANDLE_STREAM_RECONCILE_INTERVAL_MS,
  LighterCandleStreamSupervisor,
  type LighterCandleStreamEvent,
  type LighterCandleStreamSocket,
  type LighterCandleStreamSupervisorDeps,
} from "../candle-stream.js";

const SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000701";
const SECOND_SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000702";
const OPEN_TIME = 1_800_000_000_000;

class FakeSocket implements LighterCandleStreamSocket {
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
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
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

function internalCandle(
  overrides: Partial<LighterInternalCandle> = {},
): LighterInternalCandle {
  return {
    timestamp: OPEN_TIME,
    open: 100,
    high: 105,
    low: 99,
    close: 103,
    volumeBase: 10,
    volumeQuote: 1_030,
    lastTradeId: "100",
    providerResolution: "1m",
    source: "rest_snapshot",
    receivedAt: OPEN_TIME + 10,
    ...overrides,
  };
}

function candleFrame(
  type: "subscribed/candle" | "update/candle",
  candles: readonly Record<string, unknown>[],
  timestamp = OPEN_TIME + 1_000,
) {
  return {
    type,
    channel: "candle:7:1m",
    timestamp,
    candles,
  };
}

function providerCandle(overrides: Record<string, unknown> = {}) {
  return {
    t: OPEN_TIME,
    o: 100,
    h: 105,
    l: 99,
    c: 103,
    v: 10,
    V: 1_030,
    i: 100,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeHarness(history?: ReturnType<typeof deferred<readonly LighterInternalCandle[]>>) {
  const sockets: FakeSocket[] = [];
  const events: LighterCandleStreamEvent[] = [];
  const diagnostics: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const readHistory = vi.fn(() =>
    history?.promise ?? Promise.resolve([internalCandle()]),
  );
  const deps: LighterCandleStreamSupervisorDeps = {
    createSocket: vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
    readHistory,
    now: Date.now,
    random: () => 0,
    diagnostic: (event, detail) => diagnostics.push({ event, detail: { ...detail } }),
  };
  const supervisor = new LighterCandleStreamSupervisor(deps);
  return { supervisor, deps, sockets, events, diagnostics, readHistory };
}

function subscribe(harness: ReturnType<typeof makeHarness>, ownerId: number | string = 51) {
  return harness.supervisor.subscribe(
    ownerId,
    {
      subscriptionId: SUBSCRIPTION_ID,
      environment: "rhc",
      marketId: 7,
      resolution: "1m",
    },
    (event) => harness.events.push(event),
  );
}

async function connect(harness: ReturnType<typeof makeHarness>): Promise<FakeSocket> {
  subscribe(harness);
  await vi.advanceTimersByTimeAsync(0);
  const socket = requireValue(harness.sockets[0]);
  expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
    type: "subscribe",
    channel: "candle/7/1m",
  });
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(OPEN_TIME + 30_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Lighter candle stream supervisor", () => {
  it("subscribes on the read-only endpoint before starting REST history and buffers the ack", async () => {
    const history = deferred<readonly LighterInternalCandle[]>();
    const h = makeHarness(history);
    const socket = await connect(h);

    expect(h.deps.createSocket).toHaveBeenCalledWith(
      "wss://api.rh.lighter.xyz/stream?readonly=true",
    );
    expect(h.readHistory).toHaveBeenCalledWith(
      { environment: "rhc", marketId: 7, resolution: "1m" },
      300,
      OPEN_TIME + 30_000,
    );
    socket.message(candleFrame("subscribed/candle", [providerCandle({ i: 101, c: 104 })]));
    expect(h.events.some((event) => event.kind === "snapshot")).toBe(false);

    history.resolve([
      internalCandle({ timestamp: OPEN_TIME - 60_000, lastTradeId: "90" }),
      internalCandle({ lastTradeId: "100" }),
    ]);
    await vi.runAllTicks();

    const snapshot = h.events.find((event) => event.kind === "snapshot");
    expect(snapshot?.candles.map((candle) => candle.timestamp)).toEqual([
      OPEN_TIME - 60_000,
      OPEN_TIME,
    ]);
    expect(snapshot?.candles.at(-1)).toMatchObject({
      close: 104,
      lastTradeId: "101",
      source: "websocket_update",
    });
    h.supervisor.stop();
  });

  it("preserves unsafe numeric WS trade ids as exact decimal strings", async () => {
    const h = makeHarness();
    const socket = await connect(h);
    const exactId = "19694823713123456789";
    socket.rawMessage(
      `{"type":"subscribed/candle","channel":"candle:7:1m","timestamp":${OPEN_TIME + 1_000},"candles":[{"t":${OPEN_TIME},"o":100,"h":105,"l":99,"c":104,"v":10,"V":1040,"i":${exactId}}]}`,
    );
    await vi.runAllTicks();

    const snapshot = h.events.find((event) => event.kind === "snapshot");
    expect(snapshot?.candles.at(-1)?.lastTradeId).toBe(exactId);
    h.supervisor.stop();
  });

  it("applies rollover oldest-first and rejects duplicates and unseen out-of-order bars", async () => {
    const history = deferred<readonly LighterInternalCandle[]>();
    const h = makeHarness(history);
    const socket = await connect(h);
    socket.message(candleFrame("subscribed/candle", [providerCandle()]));
    history.resolve([internalCandle()]);
    await vi.runAllTicks();
    expect(h.diagnostics).toEqual([]);
    expect(h.events.some((event) => event.kind === "status" && event.status === "live")).toBe(true);
    expect(h.events.some((event) => event.kind === "snapshot")).toBe(true);
    h.events.length = 0;

    socket.message(candleFrame("update/candle", [
      providerCandle({ t: OPEN_TIME + 60_000, i: 120, o: 104, h: 107, l: 103, c: 106 }),
      providerCandle({ i: 110, c: 104 }),
    ]));
    socket.message(candleFrame("update/candle", [providerCandle({ i: 110, c: 99 })]));
    socket.message(candleFrame("update/candle", [
      providerCandle({ t: OPEN_TIME - 60_000, i: 999, c: 102 }),
    ]));
    await vi.advanceTimersByTimeAsync(0);

    const updates = h.events.filter((event) => event.kind === "update");
    expect(h.diagnostics).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.candles.map((candle) => [candle.timestamp, candle.lastTradeId])).toEqual([
      [OPEN_TIME, "110"],
      [OPEN_TIME + 60_000, "120"],
    ]);
    h.supervisor.stop();
  });

  it("keeps equal-id REST reconciliation authoritative, including sparse zero-volume bars", async () => {
    const h = makeHarness();
    h.readHistory
      .mockResolvedValueOnce([
        internalCandle({ source: "rest_snapshot", lastTradeId: "99" }),
      ])
      .mockResolvedValueOnce([
        internalCandle({
          source: "rest_snapshot",
          volumeBase: 0,
          volumeQuote: 0,
          receivedAt: OPEN_TIME + 60_000,
        }),
      ]);
    const socket = await connect(h);
    socket.message(candleFrame("subscribed/candle", [providerCandle()]));
    await vi.advanceTimersByTimeAsync(0);
    h.events.length = 0;

    await vi.advanceTimersByTimeAsync(LIGHTER_CANDLE_STREAM_RECONCILE_INTERVAL_MS);
    await vi.runAllTicks();

    const update = h.events.find((event) => event.kind === "update");
    expect(update?.candles).toEqual([
      expect.objectContaining({
        lastTradeId: "100",
        source: "rest_snapshot",
        volumeBase: 0,
        volumeQuote: 0,
      }),
    ]);
    expect(h.readHistory).toHaveBeenLastCalledWith(
      { environment: "rhc", marketId: 7, resolution: "1m" },
      3,
      expect.any(Number),
    );
    h.supervisor.stop();
  });

  it("sends keepalives, reconnects with backoff, and releases sockets on owner cleanup", async () => {
    const h = makeHarness();
    const socket = await connect(h);
    socket.message(candleFrame("subscribed/candle", [providerCandle()]));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(LIGHTER_CANDLE_STREAM_KEEPALIVE_INTERVAL_MS);
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "ping" });
    socket.emit("close");
    expect(h.events.at(-1)).toMatchObject({ kind: "status", status: "reconnecting" });
    await vi.advanceTimersByTimeAsync(799);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);

    h.supervisor.cleanupOwner(51);
    expect(h.sockets[1]?.closes.at(-1)?.reason).toBe("no_subscribers");
    h.supervisor.stop();
  });

  it("enforces owner isolation for explicit stop and rejects weekly subscriptions", () => {
    const h = makeHarness();
    const handle = subscribe(h, "renderer-a");

    expect(h.supervisor.unsubscribe("renderer-b", handle.subscriptionId)).toBe(false);
    // "1w" is deliberately outside the supported set: the supervisor must reject
    // it at runtime, so it enters through a string-typed boundary on purpose.
    const unsupportedResolution: string = "1w";
    expect(() => h.supervisor.subscribe(
      "renderer-a",
      {
        subscriptionId: SECOND_SUBSCRIPTION_ID,
        environment: "core",
        marketId: 7,
        resolution: unsupportedResolution as LighterCandleTarget["resolution"],
      },
      vi.fn(),
    )).toThrow("does not support 1w");
    expect(h.supervisor.unsubscribe("renderer-a", handle.subscriptionId)).toBe(true);
    h.supervisor.stop();
  });

  it("closes the socket on oversized or market-mismatched provider evidence", async () => {
    const h = makeHarness();
    const socket = await connect(h);
    socket.message({
      ...candleFrame("subscribed/candle", [providerCandle()]),
      channel: "candle:8:1m",
    });

    expect(socket.closes.at(-1)?.reason).toBe("invalid_candle_evidence");
    expect(h.diagnostics.at(-1)).toMatchObject({
      event: "lighter.candle_stream.frame_invalid",
      detail: { environment: "rhc", marketId: 7, resolution: "1m" },
    });
    h.supervisor.stop();
  });
});
