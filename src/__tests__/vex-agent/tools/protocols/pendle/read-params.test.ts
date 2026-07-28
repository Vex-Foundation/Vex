/**
 * Read-param contract: every NEW param is REJECTED BY NAME, never silently
 * dropped.
 *
 * The defect this locks out is quiet: `enumField` returns `undefined` for an
 * unknown value, so `sort: "yield"` used to produce liquidity ordering with no
 * word said. The agent then believes it ranked by yield and every downstream
 * decision inherits the mistake — worse than an error, because nothing surfaces.
 *
 * The protocol runtime already refuses an undeclared KEY and a wrong-typed
 * value. These parsers cover what it cannot see: a correctly-typed value outside
 * the domain.
 */

import { describe, expect, it } from "vitest";

import {
  PENDLE_YIELDS_DEFAULT_LIMIT,
  parsePendlePositionParams,
  parsePendleYieldsParams,
} from "@vex-agent/tools/protocols/pendle/read-params.js";

/** Assert the parse failed, naming `param`, and that the message says so. */
function expectRejection(
  result: ReturnType<typeof parsePendleYieldsParams> | ReturnType<typeof parsePendlePositionParams>,
  param: string,
): string {
  expect(result.ok, `expected a rejection naming \`${param}\``).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection.param).toBe(param);
  expect(result.rejection.message).toContain(param);
  return result.rejection.message;
}

function requireValue<T>(result: { ok: true; value: T } | { ok: false; rejection: unknown }): T {
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`);
  return result.value;
}

describe("parsePendleYieldsParams — defaults", () => {
  it("defaults to active-only, liquidity-descending, offset 0 and a NAMED default limit", () => {
    const q = requireValue(parsePendleYieldsParams({}));

    expect(q).toMatchObject({
      chainIds: undefined,
      includeMatured: false,
      sort: "liquidity",
      order: "desc",
      offset: 0,
      limit: PENDLE_YIELDS_DEFAULT_LIMIT,
      fields: undefined,
    });
  });

  it("accepts a large limit — there is NO hidden ceiling any more", () => {
    // The old handler clamped 200 to 50 with no echo. That is the owner's
    // no-silent-truncation rule broken in the plainest possible way.
    expect(requireValue(parsePendleYieldsParams({ limit: 500 })).limit).toBe(500);
  });

  it("treats `all` as unscoped for chains and fields", () => {
    const q = requireValue(parsePendleYieldsParams({ chains: "all", fields: "all" }));
    expect(q.chainIds).toBeUndefined();
    expect(q.fields).toBeUndefined();
  });
});

describe("parsePendleYieldsParams — rejections name the param", () => {
  it("rejects an unknown sort key and lists the accepted ones", () => {
    const message = expectRejection(parsePendleYieldsParams({ sort: "yield" }), "sort");
    expect(message).toContain("impliedApy");
    expect(message).toContain('"yield"');
  });

  it("rejects an unknown order", () => {
    expectRejection(parsePendleYieldsParams({ order: "sideways" }), "order");
  });

  it("rejects an unsupported chain and lists the supported ones", () => {
    const message = expectRejection(parsePendleYieldsParams({ chains: "ethereum,solana" }), "chains");
    expect(message).toContain("solana");
    expect(message).toContain("arbitrum");
  });

  it("rejects a negative offset and a non-positive limit", () => {
    expectRejection(parsePendleYieldsParams({ offset: -1 }), "offset");
    expectRejection(parsePendleYieldsParams({ limit: 0 }), "limit");
    expectRejection(parsePendleYieldsParams({ limit: 2.5 }), "limit");
  });

  it("rejects a non-numeric range bound", () => {
    expectRejection(parsePendleYieldsParams({ minLiquidityUsd: Number.NaN }), "minLiquidityUsd");
    expectRejection(parsePendleYieldsParams({ minLiquidityUsd: -1 }), "minLiquidityUsd");
    expectRejection(parsePendleYieldsParams({ maxDaysToExpiry: 1.5 }), "maxDaysToExpiry");
  });

  it("rejects an unparseable expiry bound", () => {
    const message = expectRejection(parsePendleYieldsParams({ expiryBefore: "next tuesday" }), "expiryBefore");
    expect(message).toContain("ISO-8601");
  });

  it("rejects an inverted range instead of silently returning nothing", () => {
    // An inverted range matches zero rows. Answering "no markets found" would be
    // a factual claim about Pendle that we have not established.
    expectRejection(
      parsePendleYieldsParams({ minLiquidityUsd: 100, maxLiquidityUsd: 10 }),
      "minLiquidityUsd",
    );
    expectRejection(
      parsePendleYieldsParams({ minImpliedApyPercent: 20, maxImpliedApyPercent: 5 }),
      "minImpliedApyPercent",
    );
    expectRejection(
      parsePendleYieldsParams({ minDaysToExpiry: 90, maxDaysToExpiry: 30 }),
      "minDaysToExpiry",
    );
  });

  it("rejects a non-boolean flag", () => {
    expectRejection(parsePendleYieldsParams({ includeMatured: "yes" }), "includeMatured");
    expectRejection(parsePendleYieldsParams({ isPrime: 1 }), "isPrime");
  });

  it("rejects an unknown field group and lists the allowed ones", () => {
    const message = expectRejection(parsePendleYieldsParams({ fields: "apy,nonsense" }), "fields");
    expect(message).toContain("liquidity");
    expect(message).toContain("nonsense");
  });
});

describe("parsePendleYieldsParams — accepted values normalize", () => {
  it("resolves chain slugs and ids, de-duplicated, and is case-insensitive", () => {
    const q = requireValue(parsePendleYieldsParams({ chains: "Ethereum, 42161 ,ethereum" }));
    expect(q.chainIds).toEqual([1, 42161]);
  });

  it("lowercases free-text filters so matching is predictable", () => {
    const q = requireValue(
      parsePendleYieldsParams({ underlyingSymbol: "USDe", categories: "Stables, POINTS" }),
    );
    expect(q.underlyingSymbol).toBe("usde");
    expect(q.categories).toEqual(["stables", "points"]);
  });

  it("accepts every documented sort key", () => {
    for (const sort of [
      "liquidity",
      "impliedApy",
      "aggregatedApy",
      "underlyingApy",
      "maxBoostedApy",
      "tvl",
      "volume",
      "expiry",
      "name",
    ]) {
      expect(requireValue(parsePendleYieldsParams({ sort })).sort).toBe(sort);
    }
  });
});

describe("parsePendlePositionParams", () => {
  it("defaults to every kind, accrued included, sorted by value", () => {
    expect(requireValue(parsePendlePositionParams({}))).toEqual({
      chainIds: undefined,
      kinds: undefined,
      redeemableOnly: false,
      minValueUsd: undefined,
      includeAccrued: true,
      sort: "value",
      fields: undefined,
    });
  });

  it("accepts a kinds subset and de-duplicates it", () => {
    expect(requireValue(parsePendlePositionParams({ kinds: "pt,lp,pt" })).kinds).toEqual(["pt", "lp"]);
  });

  it("rejects an unknown kind and names the allowed set", () => {
    const message = expectRejection(parsePendlePositionParams({ kinds: "pt,principal" }), "kinds");
    expect(message).toContain("sy");
    expect(message).toContain("principal");
  });

  it("rejects an unknown sort and a negative dust floor", () => {
    expectRejection(parsePendlePositionParams({ sort: "apy" }), "sort");
    expectRejection(parsePendlePositionParams({ minValueUsd: -5 }), "minValueUsd");
  });

  it("rejects a non-boolean flag", () => {
    expectRejection(parsePendlePositionParams({ redeemableOnly: "true" }), "redeemableOnly");
    expectRejection(parsePendlePositionParams({ includeAccrued: 0 }), "includeAccrued");
  });

  it("rejects an unknown field group", () => {
    expectRejection(parsePendlePositionParams({ fields: "balance,pnl" }), "fields");
  });
});
