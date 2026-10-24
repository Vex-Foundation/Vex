import { describe, expect, it } from "vitest";
import { analysisWindowRange, axisPrecision } from "../TechnicalAnalysisChart.js";

describe("analysisWindowRange", () => {
  it("frames the newest window, not the warm-up bars before it", () => {
    // 220 closed bars read, 100 analysed: bars 120..219 are on screen.
    expect(analysisWindowRange(220, 100)).toEqual({ from: 119.5, to: 220.5 });
  });

  it("frames every bar when fewer were read than the window", () => {
    expect(analysisWindowRange(40, 100)).toEqual({ from: -0.5, to: 40.5 });
  });

  it("always frames at least one bar", () => {
    expect(analysisWindowRange(1, 0)).toEqual({ from: -0.5, to: 1.5 });
  });
});

describe("axisPrecision", () => {
  it("keeps about four significant digits", () => {
    expect(axisPrecision(2386.55)).toBe(2);
    expect(axisPrecision(0.01234)).toBe(5);
  });
});
