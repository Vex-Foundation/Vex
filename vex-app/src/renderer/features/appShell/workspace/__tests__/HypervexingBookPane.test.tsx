import { describe, expect, it } from "vitest";

import { buildDepthLadder, spreadOf } from "../HypervexingBookPane.js";

describe("buildDepthLadder", () => {
  it("accumulates size and scales depthShare to the deepest visible level", () => {
    const ladder = buildDepthLadder([
      { px: "100", sz: "1", n: 1 },
      { px: "99", sz: "3", n: 2 },
    ]);
    expect(ladder.map((l) => l.cumulative)).toEqual([1, 4]);
    expect(ladder[0]?.depthShare).toBeCloseTo(0.25);
    expect(ladder[1]?.depthShare).toBeCloseTo(1);
  });

  it("treats malformed sizes as zero instead of poisoning the ladder", () => {
    const ladder = buildDepthLadder([
      { px: "100", sz: "not-a-number", n: 1 },
      { px: "99", sz: "2", n: 1 },
    ]);
    expect(ladder.map((l) => l.cumulative)).toEqual([0, 2]);
  });

  it("returns an empty ladder for an empty side", () => {
    expect(buildDepthLadder([])).toEqual([]);
  });
});

describe("spreadOf", () => {
  it("computes absolute and percentage spread from best bid/ask", () => {
    const spread = spreadOf("100", "101");
    expect(spread?.abs).toBe("1.00");
    expect(spread?.pct).toBe("1.000%");
  });

  it("is null when either side is missing or non-numeric", () => {
    expect(spreadOf(undefined, "101")).toBeNull();
    expect(spreadOf("100", undefined)).toBeNull();
    expect(spreadOf("zero", "101")).toBeNull();
  });
});
