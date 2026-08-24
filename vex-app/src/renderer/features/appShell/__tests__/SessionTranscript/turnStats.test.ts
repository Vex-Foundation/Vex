/**
 * Pure presentation of one turn's usage ROLLUP as micro-label stat groups -
 * boundary seams of the compact formatters, the drop-out rules for absent
 * measurements, and the snapshot-input / summed-output asymmetry that makes the
 * displayed figures describe the whole turn instead of its last round.
 */

import { describe, expect, it } from "vitest";
import type { TurnUsageRollupDto } from "@shared/schemas/usage.js";
import {
  cacheHitPercent,
  formatCost,
  formatTokens,
  turnStatGroups,
} from "../../SessionTranscript/turnStats.js";

function usage(overrides: Partial<TurnUsageRollupDto> = {}): TurnUsageRollupDto {
  return {
    sessionId: "6b1c1a58-0000-4000-8000-000000000000",
    latestRoundPromptTokens: 12_400,
    latestRoundCachedTokens: 9_920,
    turnCompletionTokens: 830,
    turnReasoningTokens: 0,
    turnCacheWriteTokens: 0,
    turnCost: 0.0042,
    turnCachedSavings: null,
    roundCount: 1,
    currency: "USD",
    provider: null,
    model: null,
    latestRoundAt: "2026-08-20T12:00:00.000Z",
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
    expect(cacheHitPercent(usage({ latestRoundPromptTokens: 0, latestRoundCachedTokens: 0 }))).toBe(
      null,
    );
  });
  it("rounds the share to an integer percent", () => {
    expect(
      cacheHitPercent(usage({ latestRoundPromptTokens: 12_400, latestRoundCachedTokens: 9_920 })),
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
    expect(turnStatGroups(usage({ latestRoundCachedTokens: 0 }))).toEqual([
      "12.4K in / 830 out",
      "$0.0042",
    ]);
  });
  it("omits the cost group when cost is unknown", () => {
    expect(turnStatGroups(usage({ turnCost: null }))).toEqual([
      "12.4K in / 830 out",
      "80% cached",
    ]);
  });
  it("is empty for an all-zero row (no groups, caller unmounts)", () => {
    expect(
      turnStatGroups(
        usage({
          latestRoundPromptTokens: 0,
          latestRoundCachedTokens: 0,
          turnCompletionTokens: 0,
          turnCost: null,
        }),
      ),
    ).toEqual([]);
  });
});

/**
 * The regression this pins: the panel used to read ONE `usage_log` row and
 * label it a turn. The engine writes one row per model round, so a fifty-round
 * turn displayed the fiftieth round's output and cost - the v0.2.6 report's
 * `OUT 1 / $0.0405`. `turnStatGroups` must read the SUMMED output and the
 * SUMMED cost, and must read input from the latest-round snapshot (summing
 * input would count the resent conversation N times).
 */
describe("a multi-round turn reports the turn, not its last round", () => {
  it("prints summed output and summed cost against the latest-round input", () => {
    expect(
      turnStatGroups(
        usage({
          // The last round of the turn resent a 38.2K-token conversation and
          // produced almost nothing; the turn as a whole generated 24.6K
          // output tokens and cost four cents.
          latestRoundPromptTokens: 38_200,
          latestRoundCachedTokens: 0,
          turnCompletionTokens: 24_600,
          turnCost: 0.0405,
          roundCount: 50,
        }),
      ),
    ).toEqual(["38.2K in / 24.6K out", "$0.0405", "50 rounds"]);
  });

  it("says how many rounds the figures cover, and stays silent for a single round", () => {
    expect(turnStatGroups(usage({ roundCount: 2 }))).toContain("2 rounds");
    expect(turnStatGroups(usage({ roundCount: 1 })).join("|")).not.toContain("round");
  });

  it("cache share divides the SAME round's cached and prompt tokens", () => {
    // Not the turn's summed cache writes against one round's prompt - that
    // ratio would exceed 100% on any cached multi-round turn.
    expect(
      cacheHitPercent(
        usage({
          latestRoundPromptTokens: 1_000,
          latestRoundCachedTokens: 250,
          turnCacheWriteTokens: 40_000,
          roundCount: 40,
        }),
      ),
    ).toBe(25);
  });
});
