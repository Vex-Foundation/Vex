/**
 * Pure presentation of one turn's usage as micro-label stat groups — boundary seams
 * of the compact formatters and the drop-out rules for absent measurements.
 */

import { describe, expect, it } from "vitest";
import type { TurnUsageDto } from "@shared/schemas/usage.js";
import {
  cacheHitPercent,
  formatCost,
  formatTokens,
  turnStatGroups,
} from "../../SessionTranscript/turnStats.js";

function usage(overrides: Partial<TurnUsageDto> = {}): TurnUsageDto {
  return {
    sessionId: "6b1c1a58-0000-4000-8000-000000000000",
    promptTokens: 12_400,
    completionTokens: 830,
    totalTokens: 13_230,
    cachedTokens: 9_920,
    reasoningTokens: 0,
    cost: 0.0042,
    cachedSavings: null,
    cacheWriteTokens: 0,
    currency: "USD",
    provider: null,
    model: null,
    createdAt: "2026-08-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("formatTokens compacts counts exactly at the unit seams", () => {
  it("prints 999 verbatim and rolls to 1K exactly at 1000", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1K"); // 1000/1000 = 1.0 -> "1"
  });
  it("keeps one decimal under three digits and drops it from 100K up", () => {
    expect(formatTokens(12_240)).toBe("12.2K"); // 12.24 -> 12.2
    expect(formatTokens(517_000)).toBe("517K"); // >= 100 -> rounded integer
  });
  it("rolls to M exactly at 1,000,000", () => {
    expect(formatTokens(999_999)).toBe("1000K"); // 999.999 -> round(1000)
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
});

describe("cacheHitPercent refuses a 0/0 read", () => {
  it("is null with zero prompt tokens (a 0/0 read is not 0% cached)", () => {
    expect(cacheHitPercent(usage({ promptTokens: 0, cachedTokens: 0 }))).toBe(
      null,
    );
  });
  it("rounds the share to an integer percent", () => {
    expect(
      cacheHitPercent(usage({ promptTokens: 12_400, cachedTokens: 9_920 })),
    ).toBe(80);
  });
});

describe("formatCost never prints a missing measurement as money", () => {
  it("is null for a null cost (NUMERIC overflow), never $0", () => {
    expect(formatCost(null, "USD")).toBe(null);
  });
  it("keeps 4 decimals under a dollar and 2 from $1 up", () => {
    expect(formatCost(0.0042, "USD")).toBe("$0.0042");
    expect(formatCost(1.5, "USD")).toBe("$1.50");
  });
  it("prefixes a non-USD currency by its code", () => {
    expect(formatCost(0.5, "EUR")).toBe("EUR 0.5000");
  });
});

describe("turnStatGroups drops absent measurements out whole", () => {
  it("renders tokens, cache share and cost for a full row", () => {
    expect(turnStatGroups(usage())).toEqual([
      "12.4K in / 830 out",
      "80% cached",
      "$0.0042",
    ]);
  });
  it("omits the cache group when nothing was cached", () => {
    expect(turnStatGroups(usage({ cachedTokens: 0 }))).toEqual([
      "12.4K in / 830 out",
      "$0.0042",
    ]);
  });
  it("omits the cost group when cost is unknown", () => {
    expect(turnStatGroups(usage({ cost: null }))).toEqual([
      "12.4K in / 830 out",
      "80% cached",
    ]);
  });
  it("is empty for an all-zero row (no groups, caller unmounts)", () => {
    expect(
      turnStatGroups(
        usage({
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          cost: null,
        }),
      ),
    ).toEqual([]);
  });
});
