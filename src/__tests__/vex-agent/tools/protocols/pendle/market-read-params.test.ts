/**
 * The input contract for the six per-market / per-asset Pendle READ tools.
 *
 * Everything asserted here is a REJECTION BY NAME. The failure this prevents is
 * the silent one: a model that asks for `timeFrame: "minute"` and receives daily
 * candles believes it read minute data, and every conclusion after that inherits
 * the mistake. The same reasoning already governs fee params on the money path —
 * a caller-supplied one is refused by name so an attempt surfaces instead of
 * vanishing (rules/90).
 *
 * The window bounds are asserted with real arithmetic rather than a shape check:
 * an hourly year is ~8,760 points, and a tool that answers it with a silent
 * prefix breaches the owner's no-truncation rule.
 */

import { describe, expect, it } from "vitest";
import type { PendleReadParamRejection, PendleReadParams } from "@vex-agent/tools/protocols/pendle/read-params.js";

import {
  PENDLE_READ_MAX_SERIES_POINTS,
  PENDLE_ORDERBOOK_MAX_LEVELS,
  PENDLE_PRICES_MAX_IDS,
  parsePendleMarketGetParams,
  parsePendleMarketHistoryParams,
  parsePendleMarketCandlesParams,
  parsePendleOrderbookParams,
  parsePendleMerkleRewardsParams,
  parsePendleAssetPricesParams,
} from "@vex-agent/tools/protocols/pendle/market-read-params.js";

const MARKET = "0x34280882267ffa6383b363e278b027be083bbe3b";
const PT = "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c";
const NOW = Date.parse("2026-07-27T00:00:00.000Z");

/** Narrow a parse result to its rejection, failing loudly when it succeeded. */
function rejection<T>(result: PendleReadParams<T>): PendleReadParamRejection {
  if (result.ok) throw new Error(`expected a rejection, got: ${JSON.stringify(result.value)}`);
  return result.rejection;
}

function parsed<T>(result: PendleReadParams<T>): T {
  if (!result.ok) throw new Error(`expected a parsed value, got rejection: ${JSON.stringify(result.rejection)}`);
  return result.value;
}

describe("pendle.market.get params", () => {
  it("accepts exactly one of market/pt/yt, lowercases a checksummed address, and names the leg", () => {
    // Mixed-case hex after a lowercase `0x` is the EIP-55 checksum form an agent
    // copies from a block explorer — it must resolve, and it must leave lowercased
    // so every comparison downstream is case-safe.
    const checksummed = `0x${PT.slice(2).toUpperCase()}`;
    const q = parsed(
      parsePendleMarketGetParams({ chain: "ethereum", pt: checksummed }),
    );
    expect(q).toEqual({ chainId: 1, address: PT, addressParam: "pt" });
  });

  it("rejects two identifiers BY NAME instead of silently preferring one", () => {
    const r = rejection(parsePendleMarketGetParams({ chain: "ethereum", market: MARKET, pt: PT }));
    expect(r.param).toBe("market");
    expect(r.message).toContain("market");
    expect(r.message).toContain("pt");
  });

  it("rejects no identifier at all, naming all three", () => {
    const r = rejection(parsePendleMarketGetParams({ chain: "ethereum" }));
    expect(r.message).toMatch(/market/);
    expect(r.message).toMatch(/pt/);
    expect(r.message).toMatch(/yt/);
  });

  it("rejects a missing chain and an unsupported chain by name", () => {
    expect(rejection(parsePendleMarketGetParams({ market: MARKET })).param).toBe("chain");
    const unsupported = rejection(parsePendleMarketGetParams({ chain: "solana", market: MARKET }));
    expect(unsupported.param).toBe("chain");
    expect(unsupported.message).toContain("solana");
  });

  it("rejects an address that is not 40-hex before it can reach a URL path", () => {
    const r = rejection(parsePendleMarketGetParams({ chain: "ethereum", market: "not-an-address" }));
    expect(r.param).toBe("market");
  });
});

describe("pendle.market.history params", () => {
  it("defaults to a daily window with a named default field set", () => {
    const q = parsed(
      parsePendleMarketHistoryParams({ chain: "ethereum", market: MARKET }, NOW),
    );
    expect(q.timeFrame).toBe("day");
    expect(q.fields.length).toBeGreaterThan(0);
  });

  it("rejects an unknown series field BY NAME and lists what is selectable", () => {
    const r = rejection(
      parsePendleMarketHistoryParams({ chain: "ethereum", market: MARKET, fields: "impliedApy,feeRate" }, NOW),
    );
    expect(r.param).toBe("fields");
    expect(r.message).toContain("feeRate");
    expect(r.message).toContain("impliedApy");
  });

  it("rejects an unknown timeFrame BY NAME", () => {
    const r = rejection(
      parsePendleMarketHistoryParams({ chain: "ethereum", market: MARKET, timeFrame: "minute" }, NOW),
    );
    expect(r.param).toBe("timeFrame");
    expect(r.message).toContain("minute");
  });

  it("rejects a window that would exceed the point bound, naming the count", () => {
    const r = rejection(
      parsePendleMarketHistoryParams(
        { chain: "ethereum", market: MARKET, timeFrame: "hour", from: "2025-07-27T00:00:00.000Z" },
        NOW,
      ),
    );
    expect(r.param).toBe("from");
    expect(r.message).toContain(String(PENDLE_READ_MAX_SERIES_POINTS));
  });

  it("accepts a window that fits the bound", () => {
    const q = parsed(
      parsePendleMarketHistoryParams(
        { chain: "ethereum", market: MARKET, timeFrame: "day", from: "2026-07-20T00:00:00.000Z", to: "2026-07-27T00:00:00.000Z" },
        NOW,
      ),
    );
    expect(q.fromIso).toBe("2026-07-20T00:00:00.000Z");
    expect(q.toIso).toBe("2026-07-27T00:00:00.000Z");
  });

  it("rejects a `to` that is not after `from`", () => {
    const r = rejection(
      parsePendleMarketHistoryParams(
        { chain: "ethereum", market: MARKET, from: "2026-07-27T00:00:00.000Z", to: "2026-07-20T00:00:00.000Z" },
        NOW,
      ),
    );
    expect(r.param).toBe("to");
  });

  it("rejects an unparseable date BY NAME", () => {
    const r = rejection(
      parsePendleMarketHistoryParams({ chain: "ethereum", market: MARKET, from: "next tuesday" }, NOW),
    );
    expect(r.param).toBe("from");
  });
});

describe("pendle.market.candles params", () => {
  it("canonicalises the window to ISO — the form this endpoint requires on REQUEST", () => {
    // The endpoint is asymmetric: response rows carry unix seconds, but a
    // unix-seconds request bound is a live 400 ("must be a Date instance").
    const q = parsed(
      parsePendleMarketCandlesParams(
        { chain: "ethereum", asset: PT, timeFrame: "day", from: "2026-07-20T00:00:00Z" },
        NOW,
      ),
    );
    expect(q.fromIso).toBe("2026-07-20T00:00:00.000Z");
    expect(q.toIso).toBeUndefined();
  });

  it("applies the same point bound as history", () => {
    const r = rejection(
      parsePendleMarketCandlesParams(
        { chain: "ethereum", asset: PT, timeFrame: "hour", from: "2025-07-27T00:00:00.000Z" },
        NOW,
      ),
    );
    expect(r.param).toBe("from");
  });
});

describe("pendle.orderbook params", () => {
  it("defaults precision and level count", () => {
    const q = parsed(
      parsePendleOrderbookParams({ chain: "ethereum", market: MARKET }),
    );
    expect(q.precision).toBe(2);
    expect(q.limit).toBeGreaterThan(0);
  });

  it("rejects a precision outside the provider's 0-3 bound BY NAME", () => {
    for (const precision of [-1, 4, 1.5]) {
      const r = rejection(parsePendleOrderbookParams({ chain: "ethereum", market: MARKET, precision }));
      expect(r.param).toBe("precision");
    }
  });

  it("rejects a non-positive level limit BY NAME", () => {
    expect(rejection(parsePendleOrderbookParams({ chain: "ethereum", market: MARKET, limit: 0 })).param).toBe("limit");
  });

  it("rejects a level limit above the declared maximum BY NAME", () => {
    // An UNBOUNDED `limit` is the one bound the order-book read does not get for
    // free: its validator caps no rows, so this parser is the only thing between
    // a book and the agent's context window.
    const r = rejection(
      parsePendleOrderbookParams({ chain: "ethereum", market: MARKET, limit: PENDLE_ORDERBOOK_MAX_LEVELS + 1 }),
    );
    expect(r.param).toBe("limit");
    expect(r.message).toContain(String(PENDLE_ORDERBOOK_MAX_LEVELS));
  });

  it("accepts the maximum itself", () => {
    const q = parsed(parsePendleOrderbookParams({ chain: "ethereum", market: MARKET, limit: PENDLE_ORDERBOOK_MAX_LEVELS }));
    expect(q.limit).toBe(PENDLE_ORDERBOOK_MAX_LEVELS);
  });
});

describe("pendle.rewards.merkle params", () => {
  it("takes no chain filter by default and never accepts a wallet address", () => {
    const q = parsed(parsePendleMerkleRewardsParams({}));
    expect(q.chainId).toBeUndefined();
    expect(Object.keys(q)).toEqual(["chainId"]);
  });

  it("resolves a chain filter and rejects an unsupported one BY NAME", () => {
    expect(parsed(parsePendleMerkleRewardsParams({ chain: "arbitrum" })).chainId).toBe(42161);
    expect(rejection(parsePendleMerkleRewardsParams({ chain: "solana" })).param).toBe("chain");
  });
});

describe("pendle.prices.assets params", () => {
  it("accepts bare addresses and composes them into the endpoint's chain-scoped ids", () => {
    const q = parsed(parsePendleAssetPricesParams({ chain: "ethereum", ids: `${PT},1-${MARKET}` }));
    expect(q.ids).toEqual([`1-${PT}`, `1-${MARKET}`]);
  });

  it("rejects an id from another chain BY NAME rather than returning nothing for it", () => {
    const r = rejection(parsePendleAssetPricesParams({ chain: "ethereum", ids: `8453-${PT}` }));
    expect(r.param).toBe("ids");
    expect(r.message).toContain("8453");
  });

  it("rejects more ids than the cap, naming the cap and the count", () => {
    const many = Array.from({ length: PENDLE_PRICES_MAX_IDS + 1 }, () => PT).join(",");
    const r = rejection(parsePendleAssetPricesParams({ chain: "ethereum", ids: many }));
    expect(r.param).toBe("ids");
    expect(r.message).toContain(String(PENDLE_PRICES_MAX_IDS));
  });

  it("rejects an unknown asset type BY NAME and accepts the documented set", () => {
    const r = rejection(parsePendleAssetPricesParams({ chain: "ethereum", type: "LP" }));
    expect(r.param).toBe("type");
    expect(r.message).toContain("PENDLE_LP");
    expect(parsed(parsePendleAssetPricesParams({ chain: "ethereum", type: "pt" })).types).toEqual(["PT"]);
  });
});
