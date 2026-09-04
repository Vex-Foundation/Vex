/**
 * `pendle.orderbook` - the resting limit-order depth Vex quotes cannot reach.
 *
 * Every Pendle convert quote pins `useLimitOrder: false`, so the price an agent
 * is shown excludes limit-order liquidity on 83 of 84 whitelisted markets
 * (G-11/G-12). This tool exists to make that forgone depth visible, which means
 * the honesty note is part of the contract, not decoration.
 *
 * The trap it must not fall into: `/v2/limit-orders/book` answers HTTP 404 for a
 * market that is not limit-order whitelisted - live-verified on the DEEPEST
 * chain-1 market. That is "this market has no book", not "the read failed", and
 * reporting it as an error would teach the agent to retry something that can
 * never succeed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes, VexError } from "../../../../../errors.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockListMarkets = vi.fn();
const mockGetOrderbook = vi.fn();
vi.mock("@tools/pendle/read/client.js", () => ({
  getPendleReadClient: () => ({
    listMarkets: (...a: unknown[]) => mockListMarkets(...a),
    getOrderbook: (...a: unknown[]) => mockGetOrderbook(...a),
  }),
}));

const { validatePendleMarketPage } = await import("@tools/pendle/read/validation/market-catalog.js");
const { validatePendleOrderbook } = await import("@tools/pendle/read/validation/orderbook.js");
const { PENDLE_READ_NO_ASSET_FACTS } = await import("@vex-agent/tools/protocols/pendle/asset-decimals.js");
const { pendleOrderbook } = await import("@vex-agent/tools/protocols/pendle/handlers/orderbook.js");
const { PENDLE_MARKETS_ACTIVE_PAGE, PENDLE_ORDERBOOK } = await import("./read-surface-fixtures.js");

const MARKET = "0x34280882267ffa6383b363e278b027be083bbe3b";
const PT = "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c";
const NOW = Date.parse("2026-07-27T12:00:00.000Z");

const activeMarkets = validatePendleMarketPage(PENDLE_MARKETS_ACTIVE_PAGE).results;
const liveBook = validatePendleOrderbook(PENDLE_ORDERBOOK);
const PT_FACTS = new Map([[PT, { symbol: "PT-wstETH-30DEC2027", decimals: 18 }]]);

function output(result: { success: boolean; data?: Record<string, unknown> }): Record<string, unknown> {
  if (!result.success || result.data === undefined) {
    throw new Error(`expected a successful read, got: ${JSON.stringify(result)}`);
  }
  return result.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListMarkets.mockImplementation((query: { ids?: string[] }) =>
    Promise.resolve({
      markets: query.ids !== undefined ? activeMarkets : [],
      total: 1,
      complete: true,
      pagesFetched: 1,
    }),
  );
  mockGetOrderbook.mockResolvedValue(liveBook);
});

describe("pendle.orderbook - a whitelisted market", () => {
  it("passes the provider-required precision and reports the book as whitelisted", async () => {
    const data = output(
      await pendleOrderbook({ chain: "ethereum", market: MARKET, precision: 3 }, PENDLE_READ_NO_ASSET_FACTS, NOW),
    );
    expect(mockGetOrderbook).toHaveBeenCalledWith(1, MARKET, { precisionDecimal: 3 });
    expect(data.whitelisted).toBe(true);
    expect(data.precision).toBe(3);
  });

  it("names the best implied APY on each side as a percent string", async () => {
    const data = output(await pendleOrderbook({ chain: "ethereum", market: MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW));
    const best = data.best as Record<string, { impliedApyPercent: string } | null>;
    expect(best.longYield?.impliedApyPercent).toBe("10.52");
    expect(best.shortYield?.impliedApyPercent).toBe("10.86");
  });

  it("marks a size UNREADABLE rather than guessing decimals for it", async () => {
    const data = output(await pendleOrderbook({ chain: "ethereum", market: MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW));
    const best = data.best as Record<string, { size: Record<string, unknown> }>;
    expect(best.longYield?.size).toEqual({ raw: "1921533336", decimals: null, exact: null, unreadable: true });
    expect(String(data.amountsNote)).toMatch(/raw base units/i);
  });

  it("reads the size exactly once the PT's decimals are supplied", async () => {
    const data = output(
      await pendleOrderbook({ chain: "ethereum", market: MARKET }, () => Promise.resolve(PT_FACTS), NOW),
    );
    const best = data.best as Record<string, { size: Record<string, unknown> }>;
    expect(best.longYield?.size).toEqual({
      raw: "1921533336",
      decimals: 18,
      exact: "0.000000001921533336",
    });
    expect(data.sizeUnit).toMatchObject({ address: PT, decimals: 18 });
    expect(data.amountsNote).toBeUndefined();
  });

  it("says so when the sizes are unreadable BECAUSE the catalogue read failed", async () => {
    const data = output(
      await pendleOrderbook({ chain: "ethereum", market: MARKET }, () =>
        Promise.reject(new VexError(ErrorCodes.PENDLE_RATE_LIMITED, "rate limited")), NOW),
    );
    expect(String(data.amountsNote)).toContain("PENDLE_RATE_LIMITED");
    expect(data.whitelisted).toBe(true);
  });

  it("bounds the levels EXPLICITLY, echoing what was kept and what exists", async () => {
    const data = output(
      await pendleOrderbook({ chain: "ethereum", market: MARKET, limit: 2 }, PENDLE_READ_NO_ASSET_FACTS, NOW),
    );
    const levels = data.levels as Record<string, unknown[]>;
    expect(levels.longYield).toHaveLength(2);
    expect(data.levelCounts).toEqual({ longYield: 5, shortYield: 1 });
    expect(data.truncated).toBe(true);
  });

  it("always carries the standing AMM-only warning", async () => {
    const data = output(await pendleOrderbook({ chain: "ethereum", market: MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW));
    expect(data.note).toBe(
      "Vex Pendle quotes are AMM-only; resting orders here may offer a better price - Vex cannot fill them.",
    );
  });
});

describe("pendle.orderbook - a market with no book", () => {
  beforeEach(() => {
    const notWhitelisted = new VexError(ErrorCodes.PENDLE_MARKET_NOT_FOUND, "Pendle has no book data (HTTP 404).");
    notWhitelisted.httpStatus = 404;
    notWhitelisted.retryable = false;
    mockGetOrderbook.mockRejectedValue(notWhitelisted);
  });

  it("answers whitelisted:false with an explanation - it is not a failed read", async () => {
    const result = await pendleOrderbook({ chain: "ethereum", market: MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW);
    expect(result.success).toBe(true);

    const data = output(result);
    expect(data.whitelisted).toBe(false);
    expect(data.levels).toBeNull();
    expect(String(data.summary).toLowerCase()).toContain("no limit-order book");
    expect(String(data.summary).toLowerCase()).toContain("amm");
  });
});

describe("pendle.orderbook - absence and input", () => {
  it("keeps a determined absence distinct from an unfinished catalogue walk", async () => {
    mockListMarkets.mockResolvedValue({ markets: [], total: 0, complete: false, pagesFetched: 1 });
    const data = output(
      await pendleOrderbook(
        { chain: "ethereum", market: "0x1111111111111111111111111111111111111111" },
        PENDLE_READ_NO_ASSET_FACTS,
        NOW,
      ),
    );
    expect(data.resolution).toBe("indeterminate");
    expect(data.absenceProven).toBe(false);
    expect(mockGetOrderbook).not.toHaveBeenCalled();
  });

  it("refuses a precision outside the provider's bound BY NAME before any call", async () => {
    const result = await pendleOrderbook(
      { chain: "ethereum", market: MARKET, precision: 9 },
      PENDLE_READ_NO_ASSET_FACTS,
      NOW,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("precision");
    expect(mockGetOrderbook).not.toHaveBeenCalled();
  });
});
