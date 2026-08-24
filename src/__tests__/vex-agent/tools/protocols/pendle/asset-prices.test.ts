/**
 * `pendle.prices.assets` — USD marks for Pendle PT / YT / LP / SY assets (G-08).
 *
 * Two contracts are asserted here. The first is honesty about what the number
 * is: a provider snapshot refreshed on the order of 15-60 seconds, for display
 * and portfolio arithmetic, NOT an executable quote — Pendle's own docs route
 * pre-trade pricing to `swapping-prices` instead. The second is that a requested
 * asset the provider did not price is REPORTED as missing rather than dropped;
 * an id that quietly disappears reads as "worth nothing".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes, VexError } from "../../../../../errors.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockGetAssetPrices = vi.fn();
vi.mock("@tools/pendle/read/client.js", () => ({
  getPendleReadClient: () => ({ getAssetPrices: (...a: unknown[]) => mockGetAssetPrices(...a) }),
}));

const { validatePendleAssetPrices } = await import("@tools/pendle/read/validation/price-series.js");
const { pendleAssetPrices } = await import("@vex-agent/tools/protocols/pendle/handlers/asset-prices.js");
const { PENDLE_ASSET_PRICES } = await import("./read-surface-fixtures.js");

const PT = "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c";
const MARKET = "0x34280882267ffa6383b363e278b027be083bbe3b";
const UNPRICED = "0x1111111111111111111111111111111111111111";
const NOW = Date.parse("2026-07-27T12:00:00.000Z");

const livePrices = validatePendleAssetPrices(PENDLE_ASSET_PRICES);

function output(result: { success: boolean; data?: Record<string, unknown> }): Record<string, unknown> {
  if (!result.success || result.data === undefined) {
    throw new Error(`expected a successful read, got: ${JSON.stringify(result)}`);
  }
  return result.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAssetPrices.mockResolvedValue(livePrices);
});

describe("pendle.prices.assets", () => {
  it("scopes the ids to the requested chain and passes the filters through", async () => {
    await pendleAssetPrices({ chain: "ethereum", ids: `${PT},${MARKET}`, type: "PT" }, NOW);
    expect(mockGetAssetPrices).toHaveBeenCalledWith({
      chainId: 1,
      ids: [`1-${PT}`, `1-${MARKET}`],
      types: ["PT"],
      skip: 0,
      limit: 50,
    });
  });

  it("returns each price as an exact decimal string, not a provider float", async () => {
    const data = output(await pendleAssetPrices({ chain: "ethereum", ids: `${PT},${MARKET}` }, NOW));
    const rows = data.prices as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: `1-${PT}`,
      chain: "ethereum",
      chainId: 1,
      address: PT,
      priceUsd: "1879.033503",
    });
    expect(rows[1]?.priceUsd).toBe("4299.640549");
  });

  it("names a requested asset the provider did not price instead of dropping it", async () => {
    const data = output(await pendleAssetPrices({ chain: "ethereum", ids: `${PT},${UNPRICED}` }, NOW));
    expect(data.missingIds).toEqual([`1-${UNPRICED}`]);
    expect(String(data.missingNote)).toMatch(/does not price/i);
  });

  it("says the price is a provider mark and not an executable quote", async () => {
    const data = output(await pendleAssetPrices({ chain: "ethereum", ids: PT }, NOW));
    expect(String(data.note)).toMatch(/15-60 ?s|15-60 seconds/i);
    expect(String(data.note).toLowerCase()).toContain("not an executable quote");
    expect(String(data.nextStep)).toContain("pendle__market_get");
  });

  it("reports paging honestly when the caller lists no ids", async () => {
    mockGetAssetPrices.mockResolvedValue({ ...livePrices, total: 120, skip: 0 });
    const data = output(await pendleAssetPrices({ chain: "ethereum", limit: 2 }, NOW));
    expect(data.count).toBe(2);
    expect(data.total).toBe(120);
    expect(data.hasMore).toBe(true);
    expect(data.nextOffset).toBe(2);
    expect(data.missingIds).toBeUndefined();
  });

  it("refuses more ids than one call may carry, BY NAME and before the call", async () => {
    const result = await pendleAssetPrices({ chain: "ethereum", ids: Array.from({ length: 51 }, () => PT).join(",") }, NOW);
    expect(result.success).toBe(false);
    expect(result.output).toContain("50");
    expect(mockGetAssetPrices).not.toHaveBeenCalled();
  });

  it("fails with a named reason rather than an empty price list", async () => {
    mockGetAssetPrices.mockRejectedValue(new VexError(ErrorCodes.PENDLE_RATE_LIMITED, "rate limited"));
    const result = await pendleAssetPrices({ chain: "ethereum", ids: PT }, NOW);
    expect(result.success).toBe(false);
    expect(result.output).toContain("PENDLE_RATE_LIMITED");
  });
});
