/**
 * W5 read-only account registers. Main resolves the session's selected EVM
 * wallet (never a renderer address), validates the venue response shape, maps
 * to a canonical DTO (newest-first, capped 100), and returns a redacted error
 * on malformed provider output. Negative paths must never touch the venue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  getSessionWalletScope: vi.fn(),
  frontendOpenOrders: vi.fn(),
  userTwapSliceFills: vi.fn(),
  userFills: vi.fn(),
  userFunding: vi.fn(),
  historicalOrders: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
vi.mock("@tools/hyperliquid/info.js", () => ({
  HyperliquidInfoClient: class {
    frontendOpenOrders = mocks.frontendOpenOrders;
    userTwapSliceFills = mocks.userTwapSliceFills;
    userFills = mocks.userFills;
    userFunding = mocks.userFunding;
    historicalOrders = mocks.historicalOrders;
  },
}));
vi.mock("../../database/sessions-db.js", () => ({
  getSessionWalletScope: mocks.getSessionWalletScope,
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  registerHyperliquidAccountReadHandlers,
  ACCOUNT_CACHE_LIMIT,
  __resetAccountCacheForTests,
  __accountCacheSizeForTests,
  __primeAccountCacheForTests,
  __storeAccountCacheForTests,
} = await import("../hyperliquid/account-reads.js");
const { CH } = await import("@shared/ipc/channels.js");

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000111";
const WALLET = "0x1111111111111111111111111111111111111111";
const sender = createTrustedSender({ sender: createTestWebContents() });

async function call(channel: string, payload: unknown): Promise<{ readonly ok: boolean; readonly data?: unknown; readonly error?: { readonly code: string; readonly redacted?: boolean; readonly message?: string } }> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing ${channel} handler.`);
  return await handler(sender, { requestId: REQUEST_ID, payload }) as never;
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  mocks.getSessionWalletScope.mockResolvedValue({
    ok: true,
    data: { evm: { id: "wallet", address: WALLET }, solana: null },
  });
  registerHyperliquidAccountReadHandlers();
});

afterEach(() => {
  handlers.clear();
});

describe("Hyperliquid account registers — mapping", () => {
  it("maps open orders newest-first with canonical trailing-zero decimals", async () => {
    mocks.frontendOpenOrders.mockResolvedValueOnce([
      { oid: 1, coin: "BTC", side: "B", limitPx: "62026.0", sz: "1.50", origSz: "2.00", orderType: "Limit", reduceOnly: false, isTrigger: false, timestamp: 100 },
      { oid: 2, coin: "ETH", side: "A", limitPx: "3000", sz: "1", orderType: "Limit", reduceOnly: true, isTrigger: false, timestamp: 200 },
    ]);

    const result = await call(CH.hyperliquid.getOpenOrders, { sessionId: SESSION_ID });

    expect(result.ok).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data.map((row) => row.oid)).toEqual([2, 1]); // newest (ts 200) first
    expect(data[1]).toMatchObject({ coin: "BTC", side: "buy", limitPx: "62026", sz: "1.5", origSz: "2" });
    expect(data[0]).toMatchObject({ coin: "ETH", side: "sell", reduceOnly: true });
    expect(mocks.frontendOpenOrders).toHaveBeenCalledWith(WALLET);
  });

  it("maps TWAP slice fills as history rows", async () => {
    mocks.userTwapSliceFills.mockResolvedValueOnce([
      { twapId: 9, fill: { coin: "BTC", side: "B", px: "60000.0", sz: "0.10", closedPnl: "1.50", fee: "0.02", dir: "Open Long", time: 500 } },
    ]);

    const result = await call(CH.hyperliquid.getTwapHistory, { sessionId: SESSION_ID });

    expect(result.ok).toBe(true);
    expect((result.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      twapId: 9, coin: "BTC", side: "buy", px: "60000", sz: "0.1", closedPnl: "1.5", fee: "0.02", timeMs: 500,
    });
  });

  it("maps trade fills with negative pnl preserved", async () => {
    mocks.userFills.mockResolvedValueOnce([
      { oid: 7, coin: "SOL", side: "A", px: "150.00", sz: "3", closedPnl: "-4.20", fee: "0.10", dir: "Close Long", time: 800 },
    ]);

    const result = await call(CH.hyperliquid.getTradeHistory, { sessionId: SESSION_ID });

    expect(result.ok).toBe(true);
    expect((result.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      coin: "SOL", side: "sell", px: "150", closedPnl: "-4.2", fee: "0.1",
    });
  });

  it("maps funding rows from the delta payload", async () => {
    mocks.userFunding.mockResolvedValueOnce([
      { time: 900, delta: { coin: "BTC", fundingRate: "0.0000125", szi: "-0.50", usdc: "-0.30", type: "funding" } },
    ]);

    const result = await call(CH.hyperliquid.getFundingHistory, { sessionId: SESSION_ID });

    expect(result.ok).toBe(true);
    expect((result.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      coin: "BTC", usdc: "-0.3", szi: "-0.5", fundingRate: "0.0000125", timeMs: 900,
    });
  });

  it("maps order history from the order/status envelope and caps to 100 rows", async () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      status: "filled",
      statusTimestamp: index,
      order: { oid: index, coin: "BTC", side: "B", limitPx: "60000", origSz: "1", orderType: "Limit", reduceOnly: false, timestamp: index },
    }));
    mocks.historicalOrders.mockResolvedValueOnce(many);

    const result = await call(CH.hyperliquid.getOrderHistory, { sessionId: SESSION_ID });

    expect(result.ok).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(100);
    expect(data[0]).toMatchObject({ status: "filled", side: "buy", statusTimeMs: 149 }); // newest kept
  });
});

describe("Hyperliquid account registers — fail closed", () => {
  it("returns an error and never calls the venue when the session has no EVM wallet", async () => {
    mocks.getSessionWalletScope.mockResolvedValueOnce({ ok: true, data: { evm: null, solana: null } });

    const result = await call(CH.hyperliquid.getOpenOrders, { sessionId: SESSION_ID });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.frontendOpenOrders).not.toHaveBeenCalled();
  });

  it("propagates a wallet-scope read failure without touching the venue", async () => {
    mocks.getSessionWalletScope.mockResolvedValueOnce({
      ok: false,
      error: { code: "internal.unexpected", domain: "hyperliquid", message: "scope read failed", retryable: true, userActionable: false, redacted: true, correlationId: REQUEST_ID },
    });

    const result = await call(CH.hyperliquid.getTradeHistory, { sessionId: SESSION_ID });

    expect(result.ok).toBe(false);
    expect(mocks.userFills).not.toHaveBeenCalled();
  });

  it("returns a redacted error on malformed provider output (no raw provider text)", async () => {
    // Distinct wallet so the 15s per-(register, wallet) cache from the mapping
    // suite cannot serve a stale ok value here.
    mocks.getSessionWalletScope.mockResolvedValueOnce({
      ok: true,
      data: { evm: { id: "w2", address: "0x2222222222222222222222222222222222222222" }, solana: null },
    });
    mocks.frontendOpenOrders.mockResolvedValueOnce([{ unexpected: "SECRET-PROVIDER-BLOB" }]);

    const result = await call(CH.hyperliquid.getOpenOrders, { sessionId: SESSION_ID });

    expect(result.ok).toBe(false);
    expect(result.error?.redacted).toBe(true);
    expect(result.error?.message ?? "").not.toContain("SECRET-PROVIDER-BLOB");
  });
});

describe("Hyperliquid account registers — bounded cache", () => {
  beforeEach(() => {
    __resetAccountCacheForTests();
  });

  it("evicts expired entries on write", () => {
    const now = Date.now();
    for (let i = 0; i < ACCOUNT_CACHE_LIMIT; i += 1) {
      __primeAccountCacheForTests(`expired:${i}`, now - 1);
    }
    expect(__accountCacheSizeForTests()).toBe(ACCOUNT_CACHE_LIMIT);

    __storeAccountCacheForTests("fresh"); // triggers prune + set

    // All expired entries swept; only the fresh write remains.
    expect(__accountCacheSizeForTests()).toBe(1);
  });

  it("never exceeds the cap even when every entry is still live", () => {
    const future = Date.now() + 1_000_000;
    for (let i = 0; i < ACCOUNT_CACHE_LIMIT; i += 1) {
      __primeAccountCacheForTests(`live:${i}`, future);
    }
    for (let i = 0; i < 25; i += 1) {
      __storeAccountCacheForTests(`new:${i}`);
      expect(__accountCacheSizeForTests()).toBeLessThanOrEqual(ACCOUNT_CACHE_LIMIT);
    }
    expect(__accountCacheSizeForTests()).toBe(ACCOUNT_CACHE_LIMIT);
  });
});
