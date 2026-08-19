/**
 * pools.fun validators against real captured bytes.
 *
 * The point of each case is a MEASURED provider behaviour, not a shape the code
 * hoped for: the two launchers disagree about `decimals`/`totalSupply`, a
 * stock-paired row carries an extra block, an empty market is a success, and
 * candles arrive as positional arrays that must not stay positional.
 */

import { describe, expect, it } from "vitest";

import { ErrorCodes, VexError } from "../../errors.js";
import { validateDiscoverPage, validateCandles } from "@tools/pools-fun/validation.js";
import { captureResponse, CAPTURES } from "./_captures.js";

describe("validateDiscoverPage - pools.fun rows", () => {
  const page = validateDiscoverPage(captureResponse(CAPTURES.discoverPoolsFun));

  it("keeps identity and provenance strict and present", () => {
    for (const row of page.results) {
      expect(row.tokenAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      // `poolId` is named like a hash but IS the Sushi V3 pool address here.
      expect(row.poolId).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(row.platform).toBe("poolsfun");
      expect(row.pairedAsset.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(row.deployedAt))).toBe(false);
    }
  });

  it("tolerates the null decimals and totalSupply every pools.fun row sends", () => {
    expect(page.results.every((r) => r.decimals === null)).toBe(true);
    expect(page.results.every((r) => r.totalSupply === null)).toBe(true);
  });

  it("carries a cursor for the next page", () => {
    expect(typeof page.nextCursor).toBe("string");
  });
});

describe("validateDiscoverPage - the other launcher's rows", () => {
  const page = validateDiscoverPage(captureResponse(CAPTURES.discoverSushiStockPaired));

  it("accepts the OPPOSITE decimals/totalSupply shape on sushi rows", () => {
    // The same field the pools.fun rows send as null comes back populated here.
    // A reader strict on either spelling breaks on half the market.
    expect(page.results.some((r) => r.decimals === 18)).toBe(true);
    expect(page.results.some((r) => typeof r.totalSupply === "string")).toBe(true);
  });

  it("keeps the pairedStock block of a stock-paired token", () => {
    const stockRow = page.results.find((r) => r.pairedAsset === "stock");
    expect(stockRow, "the capture pins a live stock-paired token").toBeDefined();
    expect(stockRow!.pairedStock?.symbol).toBe("AAPL");
    expect(stockRow!.pairedStock?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("tolerates a null feeRecipientAddress", () => {
    expect(page.results.some((r) => r.feeRecipientAddress === null)).toBe(true);
  });
});

describe("validateDiscoverPage - an empty market is not an error", () => {
  it("parses {results: [], nextCursor: null} as a valid page", () => {
    const page = validateDiscoverPage(captureResponse(CAPTURES.discoverEmpty));
    expect(page.results).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("validateDiscoverPage - rejection", () => {
  it("throws POOLS_INVALID_RESPONSE naming the field when identity is malformed", () => {
    const page = captureResponse(CAPTURES.discoverPoolsFun) as { results: Record<string, unknown>[] };
    const broken = { ...page, results: [{ ...page.results[0], tokenAddress: "not-an-address" }] };
    try {
      validateDiscoverPage(broken);
      expect.unreachable("a malformed token address must not pass");
    } catch (err) {
      expect((err as VexError).code).toBe(ErrorCodes.POOLS_INVALID_RESPONSE);
      expect((err as VexError).message).toContain("tokenAddress");
    }
  });
});

describe("row identity is pinned, not merely requested", () => {
  /**
   * The client always asks for `chain=robinhood`, but asking is not evidence:
   * this provider answers for BASE when the chain parameter goes missing, so a
   * Base-shaped row is a response it demonstrably produces. Before these
   * literals, such a row validated and the handler stamped `chain: "robinhood"`
   * on the envelope above it - Vex relabelling another chain's token, which is a
   * wrong answer rather than a failed read.
   */
  function poolsFunRow(): Record<string, unknown> {
    const page = captureResponse(CAPTURES.discoverPoolsFun) as { results: Record<string, unknown>[] };
    return { ...page.results[0] };
  }

  function pageOf(row: Record<string, unknown>): unknown {
    return { results: [row], nextCursor: null };
  }

  it("refuses a row from another chain", () => {
    try {
      validateDiscoverPage(pageOf({ ...poolsFunRow(), chain: "base" }));
      expect.unreachable("a base row must not validate as a pools.fun row");
    } catch (err) {
      expect((err as VexError).code).toBe(ErrorCodes.POOLS_INVALID_RESPONSE);
      expect((err as VexError).message).toContain("chain");
    }
  });

  it('refuses a row whose platform is the request SELECTOR "all"', () => {
    // No launcher is called "all" - it is the value a REQUEST uses to mean
    // "either". A row carrying it would name a launchpad that does not exist.
    try {
      validateDiscoverPage(pageOf({ ...poolsFunRow(), platform: "all" }));
      expect.unreachable('platform "all" must not validate on a row');
    } catch (err) {
      expect((err as VexError).message).toContain("platform");
    }
  });

  it("still accepts both real launchers", () => {
    expect(validateDiscoverPage(pageOf({ ...poolsFunRow(), platform: "sushi" })).results[0]!.platform)
      .toBe("sushi");
    expect(validateDiscoverPage(captureResponse(CAPTURES.discoverSushiStockPaired)).results.length)
      .toBeGreaterThan(0);
  });

  it("refuses candles measured in another chain's pool", () => {
    const raw = captureResponse(CAPTURES.ohlcvHour) as Record<string, unknown>;
    const pool = raw.pool as Record<string, unknown>;
    try {
      validateCandles({ ...raw, pool: { ...pool, network: "base" } });
      expect.unreachable("a base pool must not validate");
    } catch (err) {
      expect((err as VexError).message).toContain("network");
    }
  });

  it("refuses a non-ISO deployedAt rather than letting Date.parse guess", () => {
    // `Date.parse` accepts "March 3 2026" and a pile of implementation-defined
    // shapes; the age filter is computed off this field.
    expect(() => validateDiscoverPage(pageOf({ ...poolsFunRow(), deployedAt: "March 3 2026" })))
      .toThrow(VexError);
  });
});

describe("validateCandles", () => {
  const parsed = validateCandles(captureResponse(CAPTURES.ohlcvHour));

  it("lifts the positional wire tuple into named members", () => {
    const raw = (captureResponse(CAPTURES.ohlcvHour) as { ohlcv: number[][] }).ohlcv;
    expect(parsed.candles).toHaveLength(raw.length);
    const [time, open, high, low, close, volumeUsd] = raw[0]!;
    expect(parsed.candles[0]).toEqual({ time, open, high, low, close, volumeUsd });
  });

  it("keeps the pool and the quote asset the prices are denominated in", () => {
    expect(parsed.pool?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(parsed.pair?.quoteSymbol).toBe("WETH");
  });

  it("rejects a candle whose members are not all finite numbers", () => {
    expect(() => validateCandles({ ohlcv: [[1, 2, 3, 4, 5, null]], pool: null, pair: null }))
      .toThrow(VexError);
  });
});
