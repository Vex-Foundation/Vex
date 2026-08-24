import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  readList: vi.fn(),
  readSnapshot: vi.fn(),
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
  readLighterTradingSnapshot: (...args: unknown[]) => mocks.readSnapshot(...args),
}));

const { registerLighterTradingHandlers } = await import("../lighter-trading.js");
const { CH } = await import("@shared/ipc/channels.js");

const sender = createTrustedSender({ sender: createTestWebContents() });
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
  fees: { maker: "0", taker: "0" },
};

async function call(channel: string, payload: unknown): Promise<any> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Handler not registered: ${channel}`);
  return handler(sender, {
    requestId: "00000000-0000-4000-8000-000000000224",
    payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.readList.mockResolvedValue({
    environment: "rhc",
    retrievedAt: 1_787_530_000_000,
    markets: [market],
  });
  registerLighterTradingHandlers();
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
});
