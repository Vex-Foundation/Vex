/**
 * `pendle.market.get` — one market's identity, what it accepts, and its live rates.
 *
 * The behaviours that matter here are the ones a shape assertion would miss:
 *
 *  1. A MATURED market is a first-class answer. `swapping-prices` answers HTTP
 *     404 (`Given market is expired`) for one, and that 404 must become
 *     `rates: null` plus a plain sentence — never a tool failure. The matured PT
 *     is the exact position the redeem product exists for (G-02/G-18).
 *  2. "Pendle says there is no such market" and "I could not finish looking" are
 *     different facts. An incomplete catalogue walk must never be reported as a
 *     determined absence (rules/90 — refuse rather than guess).
 *  3. A raw amount without decimals is never rendered as a human amount, and a
 *     leg whose decimals could not be resolved says so.
 *
 * Every provider body below is R1's VERBATIM live capture, pushed through the
 * REAL read validators — so the handler is driven by the shapes the API actually
 * returns, not by a hand-written idea of them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes, VexError } from "../../../../../errors.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockListMarkets = vi.fn();
const mockGetMarketTokens = vi.fn();
const mockGetSwappingPrices = vi.fn();
vi.mock("@tools/pendle/read/client.js", () => ({
  getPendleReadClient: () => ({
    listMarkets: (...a: unknown[]) => mockListMarkets(...a),
    getMarketTokens: (...a: unknown[]) => mockGetMarketTokens(...a),
    getSwappingPrices: (...a: unknown[]) => mockGetSwappingPrices(...a),
  }),
}));

const { validatePendleMarketPage } = await import("@tools/pendle/read/validation/market-catalog.js");
const { validatePendleMarketTokens, validatePendleSwappingPrices } = await import(
  "@tools/pendle/read/validation/market-detail.js"
);
const { PENDLE_READ_NO_ASSET_FACTS } = await import("@vex-agent/tools/protocols/pendle/asset-decimals.js");
const { pendleMarketGet } = await import("@vex-agent/tools/protocols/pendle/handlers/market-get.js");
const { PENDLE_MARKETS_ACTIVE_PAGE, PENDLE_MARKETS_MATURED_PAGE, PENDLE_MARKET_TOKENS, PENDLE_SWAPPING_PRICES } =
  await import("./read-surface-fixtures.js");

const ACTIVE_MARKET = "0x34280882267ffa6383b363e278b027be083bbe3b";
const ACTIVE_PT = "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c";
const MATURED_MARKET = "0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654";
const NOW = Date.parse("2026-07-27T12:00:00.000Z");

const activeMarkets = validatePendleMarketPage(PENDLE_MARKETS_ACTIVE_PAGE).results;
const maturedMarkets = validatePendleMarketPage(PENDLE_MARKETS_MATURED_PAGE).results;

function catalog(markets: unknown[], complete = true) {
  return { markets, total: markets.length, complete, pagesFetched: 1 };
}

/** Serve the catalogue the resolver asks for: ids fast path, then active, then inactive. */
function serveCatalog(options: { ids?: unknown[]; active?: unknown[]; inactive?: unknown[]; complete?: boolean }): void {
  mockListMarkets.mockImplementation((query: { ids?: string[]; isActive?: boolean }) => {
    if (query.ids !== undefined) return Promise.resolve(catalog(options.ids ?? [], options.complete ?? true));
    if (query.isActive === true) return Promise.resolve(catalog(options.active ?? [], options.complete ?? true));
    return Promise.resolve(catalog(options.inactive ?? [], options.complete ?? true));
  });
}

/** The asset facts a catalogue-backed lookup would supply for the wstETH market. */
const WSTETH_FACTS = new Map([
  [ACTIVE_PT, { symbol: "PT-wstETH-30DEC2027", decimals: 18 }],
  ["0x04b7fa1e727d7290d6e24fa9b426d0c940283a95", { symbol: "YT-wstETH-30DEC2027", decimals: 18 }],
  ["0xcbc72d92b2dc8187414f6734718563898740c0bc", { symbol: "SY-wstETH", decimals: 18 }],
  ["0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", { symbol: "wstETH", decimals: 18 }],
  ["0xae7ab96520de3a18e5e111b5eaab095312d7fe84", { symbol: "stETH", decimals: 18 }],
]);

function output(result: { success: boolean; data?: Record<string, unknown> }): Record<string, unknown> {
  if (!result.success || result.data === undefined) {
    throw new Error(`expected a successful read, got: ${JSON.stringify(result)}`);
  }
  return result.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMarketTokens.mockResolvedValue(validatePendleMarketTokens(PENDLE_MARKET_TOKENS));
  mockGetSwappingPrices.mockResolvedValue(validatePendleSwappingPrices(PENDLE_SWAPPING_PRICES));
});

describe("pendle.market.get — an active market", () => {
  beforeEach(() => serveCatalog({ ids: activeMarkets }));

  it("reports identity, maturity and live rates with the unit in every field name", async () => {
    const data = output(
      await pendleMarketGet({ chain: "ethereum", market: ACTIVE_MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW),
    );

    expect(data.resolution).toBe("found");
    expect(data.chain).toBe("ethereum");
    expect(data.matured).toBe(false);
    expect(data.state).toBe("active");
    expect(data.expiry).toBe("2027-12-30T00:00:00.000Z");
    expect(data.daysToExpiry).toBe(520);
    expect(data.asOf).toBe(new Date(NOW).toISOString());

    // 0.02276412113952293 as a bare fraction in agent output is a unit trap.
    const rates = data.rates as Record<string, unknown>;
    expect(rates.impliedApyPercent).toBe("2.28");
    expect(rates.underlyingToPt).toBeCloseTo(1.2794998, 6);
    expect(rates.ptToUnderlying).toBeCloseTo(0.780096, 6);
    expect(typeof data.summary).toBe("string");
  });

  it("resolves by PT as well as by market address, and says which leg was named", async () => {
    const data = output(await pendleMarketGet({ chain: "ethereum", pt: ACTIVE_PT }, PENDLE_READ_NO_ASSET_FACTS, NOW));
    expect(data.matchedBy).toBe("pt");
    expect((data.market as Record<string, unknown>).address).toBe(ACTIVE_MARKET);
  });

  it("names every leg and leaves decimals NULL when no catalogue supplied them", async () => {
    const data = output(
      await pendleMarketGet({ chain: "ethereum", market: ACTIVE_MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW),
    );
    const legs = data.legs as Record<string, { address: string; symbol: string | null; decimals: number | null }>;
    expect(legs.pt.address).toBe(ACTIVE_PT);
    expect(legs.pt.decimals).toBeNull();
    expect(legs.pt.symbol).toBeNull();
    expect(String(data.legsNote)).toMatch(/decimals/i);
  });

  it("fills symbol and decimals from an injected asset catalogue", async () => {
    const data = output(
      await pendleMarketGet({ chain: "ethereum", market: ACTIVE_MARKET }, () => Promise.resolve(WSTETH_FACTS), NOW),
    );
    const legs = data.legs as Record<string, { symbol: string | null; decimals: number | null }>;
    expect(legs.pt).toMatchObject({ symbol: "PT-wstETH-30DEC2027", decimals: 18 });
    expect(data.legsNote).toBeUndefined();
  });

  it("distinguishes 'Pendle does not publish decimals' from 'the catalogue read failed'", async () => {
    const data = output(
      await pendleMarketGet({ chain: "ethereum", market: ACTIVE_MARKET }, () =>
        Promise.reject(new VexError(ErrorCodes.PENDLE_API_ERROR, "catalogue down")), NOW),
    );
    // The read still answers — but it must not present a failed lookup as the
    // provider simply not publishing the field.
    expect(String(data.legsNote)).toContain("PENDLE_API_ERROR");
    expect(data.resolution).toBe("found");
  });

  it("names EXACTLY the legs whose decimals are still unknown, never all of them", async () => {
    const ptOnly = new Map([[ACTIVE_PT, { symbol: "PT-wstETH-30DEC2027", decimals: 18 }]]);
    const data = output(
      await pendleMarketGet({ chain: "ethereum", market: ACTIVE_MARKET }, () => Promise.resolve(ptOnly), NOW),
    );
    const note = String(data.legsNote);
    expect(note).toContain("yt");
    expect(note).not.toMatch(/\bpt\b/);
  });

  it("bounds the accepted-token lists EXPLICITLY instead of trimming them in silence", async () => {
    const data = output(
      await pendleMarketGet({ chain: "ethereum", market: ACTIVE_MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW),
    );
    const accepts = data.accepts as Record<string, { total: number; tokens: string[]; truncated: boolean }>;
    // The live body carries ~150 `tokensIn`; a read tool must not ship them all
    // into context, and must not pretend it did not drop any.
    expect(accepts.tokensIn.total).toBeGreaterThan(accepts.tokensIn.tokens.length);
    expect(accepts.tokensIn.truncated).toBe(true);
    expect(accepts.tokensRedeemSy.truncated).toBe(false);
    expect(accepts.tokensRedeemSy.total).toBe(2);
    expect(String(data.acceptsNote)).toMatch(/tokensIn/);
  });

  it("degrades to a NAMED failure when the token read fails, keeping the rest of the answer", async () => {
    mockGetMarketTokens.mockRejectedValue(new VexError(ErrorCodes.PENDLE_API_ERROR, "upstream"));
    const data = output(
      await pendleMarketGet({ chain: "ethereum", market: ACTIVE_MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW),
    );
    expect(data.accepts).toBeNull();
    expect(String(data.acceptsNote)).toContain("PENDLE_API_ERROR");
    expect(data.rates).not.toBeNull();
    expect(data.partial).toBe(true);
  });
});

describe("pendle.market.get — a matured market", () => {
  beforeEach(() => {
    serveCatalog({ ids: maturedMarkets });
    const expired = new VexError(ErrorCodes.PENDLE_MARKET_NOT_FOUND, "Pendle has no swapping-prices data (HTTP 404).");
    expired.httpStatus = 404;
    expired.retryable = false;
    mockGetSwappingPrices.mockRejectedValue(expired);
  });

  it("answers with identity plus a plain-language rates note, NOT an error", async () => {
    const result = await pendleMarketGet({ chain: "ethereum", market: MATURED_MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW);
    expect(result.success).toBe(true);

    const data = output(result);
    expect(data.matured).toBe(true);
    expect(data.state).toBe("matured");
    expect(data.rates).toBeNull();
    expect(String(data.ratesNote).toLowerCase()).toContain("matured");
    // A matured market is still tradable in one direction — the accepts block is
    // served for it (live-verified) and must survive.
    expect(data.accepts).not.toBeNull();
    // A definitive provider verdict is not a degraded read.
    expect(data.partial).toBe(false);
  });

  it("keeps daysToExpiry negative rather than clamping it to zero", async () => {
    const data = output(
      await pendleMarketGet({ chain: "ethereum", market: MATURED_MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW),
    );
    expect(data.daysToExpiry as number).toBeLessThan(0);
  });
});

describe("pendle.market.get — absence", () => {
  const UNKNOWN = "0x1111111111111111111111111111111111111111";

  it("reports a DETERMINED absence when the whole catalogue was read", async () => {
    serveCatalog({});
    const data = output(await pendleMarketGet({ chain: "ethereum", market: UNKNOWN }, PENDLE_READ_NO_ASSET_FACTS, NOW));
    expect(data.resolution).toBe("not_found");
    expect(data.absenceProven).toBe(true);
    expect(String(data.summary).toLowerCase()).toContain("no pendle market");
  });

  it("refuses to claim absence when the catalogue walk did not finish", async () => {
    serveCatalog({ complete: false });
    const data = output(await pendleMarketGet({ chain: "ethereum", market: UNKNOWN }, PENDLE_READ_NO_ASSET_FACTS, NOW));
    expect(data.resolution).toBe("indeterminate");
    expect(data.absenceProven).toBe(false);
    expect(String(data.summary).toLowerCase()).not.toContain("no pendle market on");
    expect(String(data.summary)).toMatch(/could not|not proven|unproven/i);
  });
});

describe("pendle.market.get — input contract", () => {
  it("refuses two identifiers BY NAME instead of picking one", async () => {
    const result = await pendleMarketGet(
      { chain: "ethereum", market: ACTIVE_MARKET, pt: ACTIVE_PT },
      PENDLE_READ_NO_ASSET_FACTS,
      NOW,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("market");
    expect(result.output).toContain("pt");
    expect(mockListMarkets).not.toHaveBeenCalled();
  });

  it("refuses an unsupported chain before any provider call", async () => {
    const result = await pendleMarketGet({ chain: "solana", market: ACTIVE_MARKET }, PENDLE_READ_NO_ASSET_FACTS, NOW);
    expect(result.success).toBe(false);
    expect(result.output).toContain("solana");
    expect(mockListMarkets).not.toHaveBeenCalled();
  });
});
