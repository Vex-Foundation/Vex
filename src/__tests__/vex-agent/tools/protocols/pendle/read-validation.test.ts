/**
 * Pendle READ-surface validators, driven by the NON-EMPTY live fixtures in
 * `read-surface-fixtures.ts` (captured 2026-07-27).
 *
 * Every case here asserts one of two things: that a real recorded body parses
 * into the reduced read type, or that a body we cannot read RAISES instead of
 * degrading to an empty collection. The second half is the point — a fixture
 * that only encodes the empty collection proves nothing, and "the provider says
 * there is nothing" must never be produced by "I could not read the answer"
 * (rules/90, Verification Discipline).
 */

import { describe, expect, it } from "vitest";

import { ErrorCodes, VexError } from "../../../../../errors.js";
import {
  PENDLE_ASSET_OHLCV,
  PENDLE_ASSET_PRICES,
  PENDLE_MARKETS_ACTIVE_PAGE,
  PENDLE_MARKETS_MATURED_PAGE,
  PENDLE_MARKET_HISTORY,
  PENDLE_MARKET_TOKENS,
  PENDLE_MERKLE_FIXTURE_WALLET,
  PENDLE_MERKLE_REWARDS,
  PENDLE_ORDERBOOK,
  PENDLE_ORDERBOOK_WITH_AMM,
  PENDLE_SWAPPING_PRICES,
} from "./read-surface-fixtures.js";
import { validatePendleMarketPage } from "@tools/pendle/read/validation/market-catalog.js";
import {
  validatePendleMarketHistory,
  validatePendleMarketTokens,
  validatePendleSwappingPrices,
} from "@tools/pendle/read/validation/market-detail.js";
import {
  PENDLE_READ_MAX_CANDLE_ROWS,
  validatePendleAssetPrices,
  validatePendleCandles,
} from "@tools/pendle/read/validation/price-series.js";
import { validatePendleMerkleRewards } from "@tools/pendle/read/validation/merkle-rewards.js";
import { validatePendleOrderbook } from "@tools/pendle/read/validation/orderbook.js";

/** Deep clone so a mutation case cannot leak into the next test. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

function expectInvalidResponse(run: () => unknown): void {
  expect(run).toThrow(VexError);
  try {
    run();
  } catch (err) {
    expect(err).toMatchObject({ code: ErrorCodes.PENDLE_INVALID_RESPONSE });
  }
}

// ── /v2/markets/all ────────────────────────────────────────────────

describe("validatePendleMarketPage", () => {
  it("reads the live active page: pagination envelope plus reduced rows", () => {
    const page = validatePendleMarketPage(PENDLE_MARKETS_ACTIVE_PAGE);

    expect(page.limit).toBe(2);
    expect(page.skip).toBe(0);
    expect(page.total).toBeGreaterThan(page.results.length);
    expect(page.results).toHaveLength(2);

    const first = page.results[0]!;
    expect(first.chainId).toBe(1);
    expect(first.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(first.pt).toMatch(/^0x[0-9a-f]{40}$/);
    expect(first.yt).toMatch(/^0x[0-9a-f]{40}$/);
    expect(first.sy).toMatch(/^0x[0-9a-f]{40}$/);
    expect(first.details.liquidityUsd).toBeGreaterThan(0);
    expect(typeof first.expiry).toBe("string");
  });

  it("strips the `chainId-` prefix from every leg and lowercases addresses", () => {
    const page = validatePendleMarketPage(PENDLE_MARKETS_MATURED_PAGE);
    const market = page.results[0]!;

    expect(market.address).toBe("0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654");
    expect(market.pt).toBe("0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375");
    expect(market.yt).toBe("0x31f9e6692e87d81ff8d64de1f475fce6880a030f");
    expect(market.accountingAsset).toBe("0x4c9edd5852cd905f086c759e8383e09bff1e68b3");
    for (const leg of [market.address, market.pt, market.yt, market.sy, market.underlyingAsset]) {
      expect(leg).toBe(leg?.toLowerCase() ?? null);
    }
  });

  it("carries a MATURED market with its real expiry — the row the mutating resolvers never see", () => {
    const page = validatePendleMarketPage(PENDLE_MARKETS_MATURED_PAGE);
    const market = page.results[0]!;

    expect(market.name).toBe("srUSDe");
    expect(market.protocol).toBe("Strata");
    expect(Date.parse(market.expiry!)).toBeLessThan(Date.parse("2026-07-27T00:00:00.000Z"));
  });

  it("keeps display metrics tolerant: a null APY stays null, it never becomes 0", () => {
    const raw = copy(PENDLE_MARKETS_ACTIVE_PAGE) as { results: Array<{ details: Record<string, unknown> }> };
    raw.results[0]!.details.impliedApy = null;
    raw.results[0]!.details.pendleApy = "not-a-number";

    const market = validatePendleMarketPage(raw).results[0]!;
    expect(market.details.impliedApy).toBeNull();
    expect(market.details.pendleApy).toBeNull();
  });

  it("drops a single row with an unreadable address but keeps the readable ones", () => {
    const raw = copy(PENDLE_MARKETS_ACTIVE_PAGE) as { results: Array<Record<string, unknown>> };
    raw.results[0]!.address = "not-an-address";

    const page = validatePendleMarketPage(raw);
    expect(page.results).toHaveLength(1);
  });

  it("RAISES when the envelope is not the documented `{total,limit,skip,results}` object", () => {
    expectInvalidResponse(() => validatePendleMarketPage([{ address: "0x" }]));
    expectInvalidResponse(() => validatePendleMarketPage({ markets: [] }));
    expectInvalidResponse(() => validatePendleMarketPage(null));
  });

  it("RAISES when rows arrived but not one of them was readable", () => {
    const raw = copy(PENDLE_MARKETS_ACTIVE_PAGE) as { results: Array<Record<string, unknown>> };
    for (const row of raw.results) row.address = "";

    expectInvalidResponse(() => validatePendleMarketPage(raw));
  });

  it("returns a determined EMPTY page without throwing when the filter matched nothing", () => {
    expect(validatePendleMarketPage({ total: 0, limit: 20, skip: 0, results: [] })).toEqual({
      total: 0,
      limit: 20,
      skip: 0,
      results: [],
    });
  });
});

// ── /v1/sdk/{chainId}/markets/{market}/tokens ──────────────────────

describe("validatePendleMarketTokens", () => {
  it("reads all four token sets from the live body", () => {
    const tokens = validatePendleMarketTokens(PENDLE_MARKET_TOKENS);

    expect(tokens.tokensMintSy.length).toBeGreaterThan(0);
    expect(tokens.tokensRedeemSy.length).toBeGreaterThan(0);
    expect(tokens.tokensIn.length).toBeGreaterThan(0);
    expect(tokens.tokensOut.length).toBeGreaterThan(0);
    for (const address of tokens.tokensRedeemSy) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("RAISES when a token list carries something that is not an address", () => {
    const raw = copy(PENDLE_MARKET_TOKENS) as { tokensOut: unknown[] };
    raw.tokensOut = ["0x1234"];
    expectInvalidResponse(() => validatePendleMarketTokens(raw));
  });

  it("RAISES when a documented list is missing entirely", () => {
    const raw = copy(PENDLE_MARKET_TOKENS) as Record<string, unknown>;
    delete raw.tokensMintSy;
    expectInvalidResponse(() => validatePendleMarketTokens(raw));
  });
});

// ── /v1/sdk/{chainId}/markets/{market}/swapping-prices ─────────────

describe("validatePendleSwappingPrices", () => {
  it("reads the four directional rates and the implied APY", () => {
    const prices = validatePendleSwappingPrices(PENDLE_SWAPPING_PRICES);

    expect(prices.underlyingToken).toMatch(/^0x[0-9a-f]{40}$/);
    expect(prices.underlyingTokenToPtRate).toBeGreaterThan(0);
    expect(prices.ptToUnderlyingTokenRate).toBeGreaterThan(0);
    expect(prices.underlyingTokenToYtRate).toBeGreaterThan(0);
    expect(prices.ytToUnderlyingTokenRate).toBeGreaterThan(0);
    expect(prices.impliedApy).toBeCloseTo(0.02276, 4);
  });

  it("keeps an omitted leg NULL — an impossible swap is never a rate of zero", () => {
    const raw = copy(PENDLE_SWAPPING_PRICES) as Record<string, unknown>;
    raw.underlyingTokenToYtRate = null;
    delete raw.ytToUnderlyingTokenRate;

    const prices = validatePendleSwappingPrices(raw);
    expect(prices.underlyingTokenToYtRate).toBeNull();
    expect(prices.ytToUnderlyingTokenRate).toBeNull();
    expect(prices.underlyingTokenToPtRate).toBeGreaterThan(0);
  });

  it("RAISES when the body is not an object at all", () => {
    expectInvalidResponse(() => validatePendleSwappingPrices([]));
  });
});

// ── /v3/{chainId}/markets/{market}/historical-data ─────────────────

describe("validatePendleMarketHistory", () => {
  const REQUESTED = ["impliedApy", "tvl", "ptPrice"] as const;

  it("reads the live window into typed points", () => {
    const history = validatePendleMarketHistory(PENDLE_MARKET_HISTORY, REQUESTED);

    expect(history.total).toBe(8);
    expect(history.points).toHaveLength(8);
    expect(history.timestampStart).toBe("2026-07-20T00:00:00.000Z");
    expect(history.timestampEnd).toBe("2026-07-27T00:00:00.000Z");

    const first = history.points[0]!;
    expect(first.timestamp).toBe("2026-07-20T00:00:00.000Z");
    expect(first.values.impliedApy).toBeCloseTo(0.02275, 4);
    expect(first.values.tvl).toBeGreaterThan(0);
    expect(first.values.ptPrice).toBeGreaterThan(0);
  });

  it("keeps only the REQUESTED fields, so an unexpected extra key cannot reach a consumer", () => {
    const raw = copy(PENDLE_MARKET_HISTORY) as { results: Array<Record<string, unknown>> };
    raw.results[0]!.somethingNew = 1;

    const point = validatePendleMarketHistory(raw, REQUESTED).points[0]!;
    expect(Object.keys(point.values).sort()).toEqual(["impliedApy", "ptPrice", "tvl"]);
  });

  it("tolerates a selected field the provider omitted for a row (live: totalActiveSupply)", () => {
    const raw = copy(PENDLE_MARKET_HISTORY) as { results: Array<Record<string, unknown>> };
    delete raw.results[0]!.tvl;

    const point = validatePendleMarketHistory(raw, REQUESTED).points[0]!;
    expect(point.values.tvl).toBeUndefined();
    expect(point.values.impliedApy).toBeGreaterThan(0);
  });

  it("drops a point whose timestamp is unreadable", () => {
    const raw = copy(PENDLE_MARKET_HISTORY) as { results: Array<Record<string, unknown>> };
    raw.results[0]!.timestamp = 1784505600;

    expect(validatePendleMarketHistory(raw, REQUESTED).points).toHaveLength(7);
  });

  it("RAISES when the envelope is not `{total,results}`", () => {
    expectInvalidResponse(() => validatePendleMarketHistory({ points: [] }, REQUESTED));
  });

  it("RAISES when rows arrived but not one carried a readable timestamp", () => {
    const raw = copy(PENDLE_MARKET_HISTORY) as { results: Array<Record<string, unknown>> };
    for (const row of raw.results) delete row.timestamp;

    expectInvalidResponse(() => validatePendleMarketHistory(raw, REQUESTED));
  });
});

// ── /v4/{chainId}/prices/{asset}/ohlcv ─────────────────────────────

describe("validatePendleCandles", () => {
  it("parses the CSV-in-JSON body into typed candles", () => {
    const parsed = validatePendleCandles(PENDLE_ASSET_OHLCV);

    expect(parsed.currency).toBe("USD");
    expect(parsed.timeFrame).toBe("day");
    expect(parsed.total).toBe(8);
    expect(parsed.candles).toHaveLength(8);
    expect(parsed.truncated).toBe(false);

    const first = parsed.candles[0]!;
    expect(first.time).toBe(1784505600);
    expect(first.open).toBeCloseTo(1812.6885, 4);
    expect(first.high).toBeGreaterThanOrEqual(first.low);
    expect(first.volume).toBeCloseTo(0.1912, 4);
  });

  it("tolerates the empty trailing volume column the live body carries", () => {
    const parsed = validatePendleCandles(PENDLE_ASSET_OHLCV);
    const emptyVolume = parsed.candles.filter((c) => c.volume === null);

    expect(emptyVolume.length).toBeGreaterThan(0);
    for (const candle of emptyVolume) expect(Number.isFinite(candle.close)).toBe(true);
  });

  it("RAISES when a price column is not numeric — a candle is never guessed", () => {
    const raw = copy(PENDLE_ASSET_OHLCV) as { results: string };
    raw.results = "time,open,high,low,close,volume\n1784505600,abc,1850,1789,1838,0.19";
    expectInvalidResponse(() => validatePendleCandles(raw));
  });

  it("RAISES when the CSV header is not the documented column order", () => {
    const raw = copy(PENDLE_ASSET_OHLCV) as { results: string };
    raw.results = "time,close,open,high,low,volume\n1784505600,1,2,3,4,5";
    expectInvalidResponse(() => validatePendleCandles(raw));
  });

  it("RAISES when `results` is not a string (the CSV-in-JSON contract changed)", () => {
    const raw = copy(PENDLE_ASSET_OHLCV) as Record<string, unknown>;
    raw.results = [{ time: 1, open: 1 }];
    expectInvalidResponse(() => validatePendleCandles(raw));
  });

  it("caps the parse and says so — the tail is never dropped in silence", () => {
    const rows: string[] = ["time,open,high,low,close,volume"];
    const rowCount = PENDLE_READ_MAX_CANDLE_ROWS + 25;
    for (let i = 0; i < rowCount; i += 1) rows.push(`${1784505600 + i * 3600},1,2,0.5,1.5,3`);

    const parsed = validatePendleCandles({
      total: rowCount,
      currency: "USD",
      timeFrame: "hour",
      timestamp_start: 1784505600,
      timestamp_end: 1784505600 + rowCount * 3600,
      results: rows.join("\n"),
    });

    expect(parsed.candles).toHaveLength(PENDLE_READ_MAX_CANDLE_ROWS);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(rowCount);
  });

  it("returns a determined EMPTY series for a header-only body", () => {
    const parsed = validatePendleCandles({
      total: 0,
      currency: "USD",
      timeFrame: "day",
      results: "time,open,high,low,close,volume",
    });
    expect(parsed.candles).toEqual([]);
    expect(parsed.truncated).toBe(false);
  });
});

// ── /v1/prices/assets ──────────────────────────────────────────────

describe("validatePendleAssetPrices", () => {
  it("splits the live `{ '1-0x…': price }` MAP into chain-scoped rows", () => {
    const prices = validatePendleAssetPrices(PENDLE_ASSET_PRICES);

    expect(prices.total).toBe(2);
    expect(prices.skip).toBe(0);
    expect(prices.prices).toHaveLength(2);
    for (const row of prices.prices) {
      expect(row.chainId).toBe(1);
      expect(row.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(row.priceUsd).toBeGreaterThan(0);
    }
  });

  it("drops an entry whose key is not a `chainId-address` composite", () => {
    const raw = copy(PENDLE_ASSET_PRICES) as { prices: Record<string, unknown> };
    raw.prices["garbage"] = 1;

    expect(validatePendleAssetPrices(raw).prices).toHaveLength(2);
  });

  it("drops an entry whose price is not a finite number rather than reporting 0", () => {
    const raw = copy(PENDLE_ASSET_PRICES) as { prices: Record<string, unknown> };
    const key = Object.keys(raw.prices)[0]!;
    raw.prices[key] = "1872.59";

    expect(validatePendleAssetPrices(raw).prices).toHaveLength(1);
  });

  it("RAISES when the root is not the documented `{prices:{…}}` object", () => {
    expectInvalidResponse(() => validatePendleAssetPrices([{ id: "1-0x", price: 1 }]));
  });

  it("RAISES when entries arrived but not one was readable", () => {
    expectInvalidResponse(() => validatePendleAssetPrices({ prices: { garbage: "x" }, total: 1, skip: 0 }));
  });
});

// ── /v1/dashboard/merkle-rewards/{user} ────────────────────────────

describe("validatePendleMerkleRewards", () => {
  it("reads claimable and claimed accruals from the live body", () => {
    const rewards = validatePendleMerkleRewards(PENDLE_MERKLE_REWARDS);

    expect(rewards.claimable.length).toBeGreaterThan(0);
    const first = rewards.claimable[0]!;
    expect(first.chainId).toBe(1);
    expect(first.token).toMatch(/^0x[0-9a-f]{40}$/);
    expect(first.amountRaw).toMatch(/^\d+$/);
    expect(first.fromTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("carries NO claim material and NO wallet identity into the validated type", () => {
    const rewards = validatePendleMerkleRewards(PENDLE_MERKLE_REWARDS);
    const serialized = JSON.stringify(rewards);

    // The live endpoint returns no proof/verifyCallData at all (G-10 probe,
    // 2026-07-27) — and the merkleRoot and echoed `user` it DOES return are
    // dropped here so nothing downstream can mistake this for claim material.
    expect(serialized).not.toContain("merkleRoot");
    expect(serialized).not.toContain("proof");
    expect(serialized).not.toContain("verifyCallData");
    expect(serialized).not.toContain(PENDLE_MERKLE_FIXTURE_WALLET);
  });

  it("drops a row whose amount is not a raw base-unit digit string", () => {
    const raw = copy(PENDLE_MERKLE_REWARDS) as { claimableRewards: Array<Record<string, unknown>> };
    const kept = raw.claimableRewards.length - 1;
    raw.claimableRewards[0]!.amount = 21629940315250;

    expect(validatePendleMerkleRewards(raw).claimable).toHaveLength(kept);
  });

  it("RAISES when the root is not the documented reward envelope", () => {
    expectInvalidResponse(() => validatePendleMerkleRewards({ rewards: [] }));
  });

  it("RAISES when rows arrived but not one was readable", () => {
    const raw = copy(PENDLE_MERKLE_REWARDS) as { claimableRewards: Array<Record<string, unknown>> };
    for (const row of raw.claimableRewards) row.token = "0xnope";

    expectInvalidResponse(() => validatePendleMerkleRewards({ ...raw, claimedRewards: [] }));
  });

  it("returns a determined EMPTY result for a wallet with no merkle rewards", () => {
    expect(validatePendleMerkleRewards({ claimableRewards: [], claimedRewards: [] })).toEqual({
      claimable: [],
      claimed: [],
    });
  });
});

// ── /v2/limit-orders/book/{chainId} ────────────────────────────────

describe("validatePendleOrderbook", () => {
  it("reads both sides of the live book with RAW base-unit sizes", () => {
    const book = validatePendleOrderbook(PENDLE_ORDERBOOK);

    expect(book.longYieldEntries.length).toBeGreaterThan(0);
    expect(book.shortYieldEntries.length).toBeGreaterThan(0);

    const level = book.longYieldEntries[0]!;
    expect(level.impliedApy).toBeCloseTo(0.1052, 4);
    expect(level.limitOrderSizeRaw).toMatch(/^\d+$/);
    expect(level.ammSizeRaw).toBeNull();
  });

  it("reads `ammSize` only when the request asked for it", () => {
    const book = validatePendleOrderbook(PENDLE_ORDERBOOK_WITH_AMM);
    expect(book.longYieldEntries[0]!.ammSizeRaw).toMatch(/^\d+$/);
  });

  it("drops a level whose size is not a raw base-unit digit string", () => {
    const raw = copy(PENDLE_ORDERBOOK) as { longYieldEntries: Array<Record<string, unknown>> };
    const kept = raw.longYieldEntries.length - 1;
    raw.longYieldEntries[0]!.limitOrderSize = 1921333074;

    expect(validatePendleOrderbook(raw).longYieldEntries).toHaveLength(kept);
  });

  it("RAISES when neither documented side is present", () => {
    expectInvalidResponse(() => validatePendleOrderbook({ bids: [], asks: [] }));
  });

  it("RAISES when levels arrived but not one was readable", () => {
    const raw = copy(PENDLE_ORDERBOOK) as { longYieldEntries: Array<Record<string, unknown>> };
    for (const level of raw.longYieldEntries) delete level.impliedApy;

    expectInvalidResponse(() => validatePendleOrderbook({ ...raw, shortYieldEntries: [] }));
  });

  it("returns a determined EMPTY book for a whitelisted market with no resting orders", () => {
    expect(validatePendleOrderbook({ longYieldEntries: [], shortYieldEntries: [] })).toEqual({
      longYieldEntries: [],
      shortYieldEntries: [],
    });
  });
});
