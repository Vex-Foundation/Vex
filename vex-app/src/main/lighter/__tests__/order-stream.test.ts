import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import {
  LIGHTER_ORDER_STREAM_AUTH_ROTATION_MS,
  LIGHTER_ORDER_STREAM_DISCOVERY_INTERVAL_MS,
  LIGHTER_ORDER_STREAM_HANDSHAKE_TIMEOUT_MS,
  LIGHTER_ORDER_STREAM_KEEPALIVE_INTERVAL_MS,
  LighterOrderStreamSupervisor,
  type LighterOrderStreamSocket,
  type LighterOrderStreamSupervisorDeps,
  type LighterOrderStreamTarget,
} from "../order-stream.js";

const CREDENTIAL: LighterTradingCredentialVaultReference = {
  kind: "encrypted_vault_reference",
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  vaultCredentialId: "lighter/rhc/account-42/api-key-7",
};
const TARGET: LighterOrderStreamTarget = {
  environment: "rhc",
  accountIndex: 42,
  credential: CREDENTIAL,
};
const AUTH_TOKEN = "9999999999:42:7:abcdef";

class FakeSocket implements LighterOrderStreamSocket {
  readonly createdAt = Date.now();
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

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void {
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
}

function orderFrame(status = "filled") {
  return {
    type: "update/account_all_orders",
    channel: "account_all_orders:42",
    orders: {
      "0": [{
        order_index: 987,
        client_order_index: 123456,
        order_id: "987",
        client_order_id: "123456",
        market_index: 0,
        owner_account_index: 42,
        initial_base_amount: "1.0",
        price: "2000.00",
        status,
      }],
    },
  };
}

function tradeFrame() {
  return {
    type: "update/account_all_trades",
    channel: "account_all_trades:42",
    trades: {
      "0": [{
        trade_id: 1001,
        trade_id_str: "1001",
        tx_hash: "0xtrade",
        type: "trade",
        market_id: 0,
        size: "1.0",
        price: "2000.00",
        usd_amount: "2000.00",
        ask_id: 987,
        ask_id_str: "987",
        bid_id: 988,
        bid_id_str: "988",
        ask_client_id: 123456,
        ask_client_id_str: "123456",
        bid_client_id: 654321,
        bid_client_id_str: "654321",
        ask_account_id: 42,
        bid_account_id: 43,
        is_maker_ask: true,
        block_height: 99,
        timestamp: 1_800_000_000_000,
      }],
    },
  };
}

function positionFrame() {
  return {
    type: "update/account_all_positions",
    channel: "account_all_positions:42",
    positions: {
      "0": {
        market_id: 0,
        symbol: "ETH",
        initial_margin_fraction: "0.05",
        open_order_count: 0,
        pending_order_count: 0,
        position_tied_order_count: 0,
        sign: 1,
        position: "0",
        avg_entry_price: "0",
        position_value: "0",
        unrealized_pnl: "0",
        realized_pnl: "10",
        liquidation_price: "0",
        margin_mode: 0,
        allocated_margin: "0",
      },
    },
    shares: [],
  };
}

function makeHarness() {
  const sockets: FakeSocket[] = [];
  let vaultListener: ((state: "unlocked" | "locked") => void) | null = null;
  let unlocked = true;
  const listTargets = vi.fn(async () => [TARGET] as readonly LighterOrderStreamTarget[]);
  const resolveAuth = vi.fn(async () => ({ token: AUTH_TOKEN, accountIndex: 42 }));
  const reconcile = vi.fn(async () => undefined);
  const resnapshot = vi.fn(async () => undefined);
  const diagnostics: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const deps: LighterOrderStreamSupervisorDeps = {
    listTargets,
    resolveAuth,
    createSocket: vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
    reconcile,
    resnapshot,
    isVaultUnlocked: () => unlocked,
    onVaultLifecycle: (listener) => {
      vaultListener = listener;
      return () => {
        vaultListener = null;
      };
    },
    now: Date.now,
    random: () => 0,
    diagnostic: (event, detail) => diagnostics.push({ event, detail: { ...detail } }),
  };
  return {
    deps,
    sockets,
    listTargets,
    resolveAuth,
    reconcile,
    resnapshot,
    diagnostics,
    lock: () => {
      unlocked = false;
      vaultListener?.("locked");
    },
    unlock: () => {
      unlocked = true;
      vaultListener?.("unlocked");
    },
  };
}

async function startHarness(harness: ReturnType<typeof makeHarness>) {
  const supervisor = new LighterOrderStreamSupervisor(harness.deps);
  const stop = supervisor.start();
  await vi.advanceTimersToNextTimerAsync();
  await vi.advanceTimersToNextTimerAsync();
  return stop;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Lighter order stream supervisor", () => {
  it("uses the read-only WebSocket endpoint and subscribes only after the server connects", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);

    expect(h.deps.createSocket).toHaveBeenCalledWith("wss://api.rh.lighter.xyz/stream?readonly=true");
    expect(h.sockets[0]?.sent).toEqual([]);
    h.sockets[0]!.message({ type: "connected" });
    await vi.runAllTicks();

    expect(h.sockets[0]!.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "subscribe", channel: "account_all_orders/42", auth: AUTH_TOKEN },
      { type: "subscribe", channel: "account_all_trades/42" },
      { type: "subscribe", channel: "account_all_positions/42" },
    ]);
    expect(h.resnapshot).toHaveBeenCalledWith(
      "rhc",
      42,
      { token: AUTH_TOKEN, accountIndex: 42 },
    );
    expect(JSON.stringify(h.diagnostics)).not.toContain(AUTH_TOKEN);
    stop();
  });

  it("validates and serializes exact order frames before reconciliation", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);
    const socket = h.sockets[0]!;
    socket.message({ type: "connected" });
    socket.message(orderFrame());
    await vi.runAllTicks();

    expect(h.reconcile).toHaveBeenCalledWith(
      "rhc",
      42,
      expect.objectContaining({ type: "update/account_all_orders" }),
    );
    socket.message({ ...orderFrame(), channel: "account_all_orders:43" });
    expect(socket.closes.at(-1)?.reason).toBe("invalid_account_evidence");
    stop();
  });

  it("validates trade and position frames before serialized reconciliation", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);
    const socket = h.sockets[0]!;
    socket.message({ type: "connected" });
    socket.message(tradeFrame());
    socket.message(positionFrame());
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.reconcile).toHaveBeenNthCalledWith(
      1,
      "rhc",
      42,
      expect.objectContaining({ type: "update/account_all_trades" }),
    );
    expect(h.reconcile).toHaveBeenNthCalledWith(
      2,
      "rhc",
      42,
      expect.objectContaining({ type: "update/account_all_positions" }),
    );
    stop();
  });

  it("rejects non-text frames without exposing their contents", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);
    const socket = h.sockets[0]!;

    socket.emit("message", { data: new Uint8Array([1, 2, 3]) });

    expect(socket.closes.at(-1)?.reason).toBe("invalid_frame");
    expect(h.diagnostics.at(-1)).toEqual({
      event: "lighter.order_stream.frame_invalid",
      detail: { environment: "rhc", accountIndex: 42 },
    });
    stop();
  });

  it("sends application keepalives and answers server pings", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);
    const socket = h.sockets[0]!;
    socket.message({ type: "connected" });
    socket.message({ type: "ping" });

    expect(socket.sent.map((item) => JSON.parse(item))).toContainEqual({ type: "pong" });
    await vi.advanceTimersByTimeAsync(LIGHTER_ORDER_STREAM_KEEPALIVE_INTERVAL_MS);
    expect(socket.sent.map((item) => JSON.parse(item))).toContainEqual({ type: "ping" });
    stop();
  });

  it("reconnects when the server never completes its connection handshake", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);
    const socket = h.sockets[0]!;
    const remainingMs = socket.createdAt
      + LIGHTER_ORDER_STREAM_HANDSHAKE_TIMEOUT_MS
      - Date.now();

    await vi.advanceTimersByTimeAsync(remainingMs - 1);
    expect(socket.closes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closes.at(-1)?.reason).toBe("handshake_timeout");
    stop();
  });

  it("closes the authenticated socket synchronously when the vault locks", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);
    const socket = h.sockets[0]!;
    socket.message({ type: "connected" });

    h.lock();

    expect(socket.closes.at(-1)?.reason).toBe("vault_locked");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(1);
    stop();
  });

  it("stays dormant while locked and starts immediately after unlock", async () => {
    const h = makeHarness();
    h.lock();
    const stop = await startHarness(h);
    expect(h.sockets).toHaveLength(0);

    h.unlock();
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersToNextTimerAsync();
    expect(h.sockets).toHaveLength(1);
    stop();
  });

  it("cannot create a watcher when the vault locks during target discovery", async () => {
    const h = makeHarness();
    let finishDiscovery!: (targets: readonly LighterOrderStreamTarget[]) => void;
    h.listTargets.mockImplementationOnce(() => new Promise((resolve) => {
      finishDiscovery = resolve;
    }));
    const supervisor = new LighterOrderStreamSupervisor(h.deps);
    const stop = supervisor.start();
    await vi.advanceTimersToNextTimerAsync();

    h.lock();
    finishDiscovery([TARGET]);
    await vi.runAllTicks();
    expect(h.sockets).toHaveLength(0);

    h.unlock();
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersToNextTimerAsync();
    expect(h.sockets).toHaveLength(1);
    stop();
  });

  it("reconnects with bounded backoff and mints a fresh auth token", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);
    const first = h.sockets[0]!;
    first.message({ type: "connected" });
    first.message(orderFrame("open"));
    await vi.runAllTicks();
    first.emit("close");

    await vi.advanceTimersByTimeAsync(799);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
    expect(h.resolveAuth).toHaveBeenCalledTimes(2);
    stop();
  });

  it("rotates the account auth token before its ten-minute expiry", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);
    const first = h.sockets[0]!;
    first.message({ type: "connected" });

    for (let minute = 0; minute < 7; minute += 1) {
      await vi.advanceTimersByTimeAsync(LIGHTER_ORDER_STREAM_KEEPALIVE_INTERVAL_MS);
      first.message({ type: "pong" });
    }
    await vi.advanceTimersByTimeAsync(
      LIGHTER_ORDER_STREAM_AUTH_ROTATION_MS
        - (7 * LIGHTER_ORDER_STREAM_KEEPALIVE_INTERVAL_MS)
        - 1,
    );
    expect(first.closes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.closes.at(-1)?.reason).toBe("auth_rotation");
    stop();
  });

  it("stops watching after durable state has no nonterminal orders", async () => {
    const h = makeHarness();
    const stop = await startHarness(h);
    const socket = h.sockets[0]!;
    h.listTargets.mockResolvedValueOnce([]);

    await vi.advanceTimersByTimeAsync(LIGHTER_ORDER_STREAM_DISCOVERY_INTERVAL_MS);

    expect(socket.closes.at(-1)?.reason).toBe("no_watchable_orders");
    stop();
  });
});
