import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  readList: vi.fn(),
  readSnapshot: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  cleanupOwner: vi.fn(),
  publicSubscribe: vi.fn(),
  publicUnsubscribe: vi.fn(),
  publicCleanupOwner: vi.fn(),
  readAccount: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lighter/trading-panel-service.js", () => ({
  readLighterTradingMarketList: (...args: unknown[]) => mocks.readList(...args),
  readLighterTradingMarketSnapshot: (...args: unknown[]) => mocks.readSnapshot(...args),
}));
vi.mock("../../lighter/candle-stream.js", () => ({
  subscribeLighterCandleStream: (...args: unknown[]) => mocks.subscribe(...args),
  unsubscribeLighterCandleStream: (...args: unknown[]) => mocks.unsubscribe(...args),
  cleanupLighterCandleStreamsForOwner: (...args: unknown[]) =>
    mocks.cleanupOwner(...args),
}));
vi.mock("../../lighter/public-market-stream.js", () => ({
  subscribeLighterPublicMarket: (...args: unknown[]) => mocks.publicSubscribe(...args),
  unsubscribeLighterPublicMarket: (...args: unknown[]) => mocks.publicUnsubscribe(...args),
  cleanupLighterPublicMarketsForOwner: (...args: unknown[]) =>
    mocks.publicCleanupOwner(...args),
}));
vi.mock("../../lighter/trading-account-service.js", () => ({
  readLighterTradingAccount: (...args: unknown[]) => mocks.readAccount(...args),
}));

const { registerLighterTradingHandlers } = await import("../lighter-trading.js");
const { CH } = await import("@shared/ipc/channels.js");

class TestWebContents {
  readonly send = vi.fn();
  private destroyed = false;
  private readonly destroyedListeners = new Set<() => void>();

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: string, listener: () => void): void {
    if (event === "destroyed") this.destroyedListeners.add(listener);
  }

  removeListener(event: string, listener: () => void): void {
    if (event === "destroyed") this.destroyedListeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of [...this.destroyedListeners]) listener();
    this.destroyedListeners.clear();
  }
}

let primaryWebContents: TestWebContents;
let secondaryWebContents: TestWebContents;
let sender: ReturnType<typeof createTrustedSender<{ sender: TestWebContents }>>;
let otherSender: ReturnType<typeof createTrustedSender<{ sender: TestWebContents }>>;
let teardowns: Array<() => void> = [];
const market = {
  marketId: 7,
  symbol: "ETH-USD",
  marketType: "perp",
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 2,
  minBaseAmount: "0.001",
  minQuoteAmount: "10",
  orderQuoteLimit: "1000000",
  decimals: { size: 4, price: 2, quote: 6 },
  fees: { maker: "0", taker: "0", makerEnabled: false, takerEnabled: false },
};
const account = {
  environment: "rhc",
  retrievedAt: 1_787_530_000_000,
  status: "ready",
  accountIndex: 42,
  openOrdersAvailable: true,
  summary: {
    collateral: "100",
    availableBalance: "80",
    unrealizedPnl: "2.5",
  },
  assets: [],
  positions: [],
  openOrders: [],
};

async function call(
  channel: string,
  payload: unknown,
  event: TestIpcEvent = sender,
): Promise<any> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Handler not registered: ${channel}`);
  return handler(event, {
    requestId: "00000000-0000-4000-8000-000000000224",
    payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  primaryWebContents = new TestWebContents(101);
  secondaryWebContents = new TestWebContents(202);
  sender = createTrustedSender({ sender: primaryWebContents });
  otherSender = createTrustedSender({ sender: secondaryWebContents });
  mocks.readList.mockResolvedValue({
    environment: "rhc",
    retrievedAt: 1_787_530_000_000,
    markets: [market],
  });
  mocks.subscribe.mockImplementation(
    (
      _ownerId: number,
      input: { subscriptionId: string },
      _listener: (event: unknown) => void,
    ) => ({ subscriptionId: input.subscriptionId, unsubscribe: vi.fn() }),
  );
  mocks.unsubscribe.mockReturnValue(true);
  mocks.publicSubscribe.mockImplementation(
    (
      _ownerId: number,
      input: { subscriptionId: string },
      _listener: (event: unknown) => void,
    ) => ({ subscriptionId: input.subscriptionId, unsubscribe: vi.fn() }),
  );
  mocks.publicUnsubscribe.mockReturnValue(true);
  mocks.readAccount.mockResolvedValue(account);
  teardowns = registerLighterTradingHandlers();
});

afterEach(() => {
  for (const teardown of teardowns.reverse()) teardown();
  teardowns = [];
});

describe("lighterTrading IPC", () => {
  it("returns only the validated market DTO", async () => {
    const result = await call(CH.lighterTrading.listMarkets, { environment: "rhc" });

    expect(result.ok).toBe(true);
    expect(result.data.markets[0]).toEqual(market);
    expect(mocks.readList).toHaveBeenCalledWith("rhc");
  });

  it("rejects auth-shaped extra input before reaching the service", async () => {
    const result = await call(CH.lighterTrading.listMarkets, {
      environment: "rhc",
      authToken: "must-not-cross",
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("validation.invalid_input");
    expect(mocks.readList).not.toHaveBeenCalled();
  });

  it("redacts provider failures", async () => {
    mocks.readList.mockRejectedValueOnce(new Error("provider body with sensitive text"));

    const result = await call(CH.lighterTrading.listMarkets, { environment: "core" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "provider.unavailable",
      domain: "market",
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain("provider body");
  });

  it("accepts only an environment for the account snapshot and returns the validated DTO", async () => {
    const result = await call(CH.lighterTrading.getAccount, { environment: "rhc" });

    expect(result).toEqual({ ok: true, data: account });
    expect(mocks.readAccount).toHaveBeenCalledWith("rhc");

    mocks.readAccount.mockClear();
    const refused = await call(CH.lighterTrading.getAccount, {
      environment: "rhc",
      authToken: "must-not-cross",
      accountIndex: 42,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("validation.invalid_input");
    expect(mocks.readAccount).not.toHaveBeenCalled();
  });

  it("redacts account-read failures at the IPC boundary", async () => {
    mocks.readAccount.mockRejectedValueOnce(new Error("provider echoed privileged-token"));

    const result = await call(CH.lighterTrading.getAccount, { environment: "core" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "provider.unavailable",
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain("privileged-token");
  });

  it("binds a renderer UUID to its sender and forwards only validated candle events", async () => {
    const subscriptionId = "00000000-0000-4000-8000-000000000225";
    const input = {
      subscriptionId,
      environment: "rhc" as const,
      marketId: 7,
      resolution: "1m" as const,
    };
    let listener: ((event: unknown) => void) | undefined;
    mocks.subscribe.mockImplementationOnce(
      (
        _ownerId: number,
        target: typeof input,
        callback: (event: unknown) => void,
      ) => {
        listener = callback;
        return { subscriptionId: target.subscriptionId, unsubscribe: vi.fn() };
      },
    );

    const result = await call(CH.lighterTrading.startCandleSubscription, input);
    expect(result).toEqual({ ok: true, data: { ...input, status: "started" } });
    expect(mocks.subscribe).toHaveBeenCalledWith(101, input, expect.any(Function));

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
      source: "rest_snapshot",
    };
    listener?.({
      kind: "snapshot",
      ...input,
      providerTimestamp: 1_787_530_000_000,
      receivedAt: 1_787_530_000_050,
      candles: [candle],
    });
    listener?.({
      kind: "update",
      ...input,
      providerTimestamp: 1_787_530_000_000,
      receivedAt: 1_787_530_000_050,
      candles: [{ ...candle, source: "websocket_update" }],
    });
    listener?.({
      kind: "status",
      status: "delayed",
      ...input,
      providerTimestamp: null,
      receivedAt: 1_787_530_000_050,
      candles: [],
    });
    listener?.({
      kind: "update",
      ...input,
      providerTimestamp: 1_787_530_000_000,
      receivedAt: 1_787_530_000_050,
      candles: [{ ...candle, source: "raw_provider", secret: true }],
    });

    expect(primaryWebContents.send).toHaveBeenCalledTimes(3);
    expect(primaryWebContents.send).toHaveBeenCalledWith(
      "vex:event:lighter:candleSnapshot",
      expect.objectContaining({ subscriptionId, status: "live", candles: [candle] }),
    );
    expect(primaryWebContents.send).toHaveBeenCalledWith(
      "vex:event:lighter:candleUpdate",
      expect.objectContaining({ subscriptionId, status: "live" }),
    );
    expect(primaryWebContents.send).toHaveBeenCalledWith(
      "vex:event:lighter:candleStatus",
      expect.objectContaining({
        subscriptionId,
        status: "delayed",
        providerTimestamp: null,
        candles: [],
      }),
    );
    expect(secondaryWebContents.send).not.toHaveBeenCalled();
  });

  it("refuses cross-sender stop and cleans subscriptions when the owning sender is destroyed", async () => {
    const subscriptionId = "00000000-0000-4000-8000-000000000226";
    const input = {
      subscriptionId,
      environment: "core" as const,
      marketId: 7,
      resolution: "5m" as const,
    };
    await call(CH.lighterTrading.startCandleSubscription, input);

    const refused = await call(
      CH.lighterTrading.stopCandleSubscription,
      { subscriptionId },
      otherSender,
    );
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("validation.invalid_input");
    expect(mocks.unsubscribe).not.toHaveBeenCalled();

    primaryWebContents.destroy();
    expect(mocks.cleanupOwner).toHaveBeenCalledWith(101);
  });

  it("stops only the exact owned subscription", async () => {
    const subscriptionId = "00000000-0000-4000-8000-000000000227";
    await call(CH.lighterTrading.startCandleSubscription, {
      subscriptionId,
      environment: "rhc",
      marketId: 7,
      resolution: "15m",
    });

    const result = await call(CH.lighterTrading.stopCandleSubscription, {
      subscriptionId,
    });
    expect(result).toEqual({
      ok: true,
      data: { subscriptionId, status: "stopped" },
    });
    expect(mocks.unsubscribe).toHaveBeenCalledWith(101, subscriptionId);
  });

  it("rejects malformed start requests before supervisor access", async () => {
    const invalidId = await call(CH.lighterTrading.startCandleSubscription, {
      subscriptionId: "invalid",
      environment: "rhc",
      marketId: 7,
      resolution: "1m",
      signer: true,
    });
    const unsupportedLiveResolution = await call(
      CH.lighterTrading.startCandleSubscription,
      {
        subscriptionId: "00000000-0000-4000-8000-000000000228",
        environment: "rhc",
        marketId: 7,
        resolution: "1w",
      },
    );
    expect(invalidId.ok).toBe(false);
    expect(invalidId.error.code).toBe("validation.invalid_input");
    expect(unsupportedLiveResolution.ok).toBe(false);
    expect(unsupportedLiveResolution.error.code).toBe("validation.invalid_input");
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("owner-scopes and validates sanitized public market stream events", async () => {
    const subscriptionId = "00000000-0000-4000-8000-000000000229";
    const input = {
      subscriptionId,
      environment: "core" as const,
      marketId: 1,
      marketType: "perp" as const,
    };
    let listener: ((event: unknown) => void) | undefined;
    mocks.publicSubscribe.mockImplementationOnce(
      (
        _ownerId: number,
        target: typeof input,
        callback: (event: unknown) => void,
      ) => {
        listener = callback;
        return { subscriptionId: target.subscriptionId, unsubscribe: vi.fn() };
      },
    );

    expect(await call(CH.lighterTrading.startPublicMarketSubscription, input)).toEqual({
      ok: true,
      data: { ...input, status: "started" },
    });
    listener?.({
      kind: "book",
      ...input,
      status: "live",
      providerTimestamp: 1_787_530_000_000,
      receivedAt: 1_787_530_000_050,
      nonce: "90071992547409931234",
      book: { asks: [{ price: "4201", size: "2" }], bids: [] },
    });
    listener?.({
      kind: "book",
      ...input,
      marketId: 2,
      status: "live",
      providerTimestamp: 1_787_530_000_000,
      receivedAt: 1_787_530_000_050,
      nonce: "11",
      book: { asks: [], bids: [], rawProvider: true },
    });
    expect(primaryWebContents.send).toHaveBeenCalledOnce();
    expect(primaryWebContents.send).toHaveBeenCalledWith(
      "vex:event:lighter:publicBook",
      expect.objectContaining({ subscriptionId, marketId: 1 }),
    );
    expect(secondaryWebContents.send).not.toHaveBeenCalled();

    const refused = await call(
      CH.lighterTrading.stopPublicMarketSubscription,
      { subscriptionId },
      otherSender,
    );
    expect(refused.ok).toBe(false);
    expect(mocks.publicUnsubscribe).not.toHaveBeenCalled();

    primaryWebContents.destroy();
    expect(mocks.publicCleanupOwner).toHaveBeenCalledWith(101);
  });
});
