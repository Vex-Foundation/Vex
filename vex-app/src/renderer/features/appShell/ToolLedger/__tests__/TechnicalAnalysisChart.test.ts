import { describe, expect, it } from "vitest";
import { analysisWindowRange, axisPrecision, pinchRange, prependOlder } from "../TechnicalAnalysisChart.js";

const bar = (t: number) => ({ t, o: 1, h: 1, l: 1, c: 1 });

describe("prependOlder", () => {
  it("puts strictly older bars in front, oldest first, and reports the shift", () => {
    const held = [bar(300), bar(400)];
    const { merged, added } = prependOlder(held, [bar(200), bar(100), bar(300), bar(400)]);
    expect(merged.map((c) => c.t)).toEqual([100, 200, 300, 400]);
    expect(added).toBe(2);
  });

  it("drops duplicates inside the older page", () => {
    const { merged, added } = prependOlder([bar(300)], [bar(100), bar(100), bar(200)]);
    expect(merged.map((c) => c.t)).toEqual([100, 200, 300]);
    expect(added).toBe(2);
  });

  it("keeps the held series when nothing older came back", () => {
    const held = [bar(300)];
    const { merged, added } = prependOlder(held, [bar(300), bar(500)]);
    expect(merged).toBe(held);
    expect(added).toBe(0);
  });
});

describe("pinchRange", () => {
  it("zooms in about the anchor on a negative delta", () => {
    const next = pinchRange({ from: 0, to: 100 }, 50, -50);
    expect(next.to - next.from).toBeLessThan(100);
    expect((next.from + next.to) / 2).toBeCloseTo(50);
  });

  it("never narrows below ten bars", () => {
    const next = pinchRange({ from: 0, to: 20 }, 10, -1_000);
    expect(next.to - next.from).toBeCloseTo(10);
  });
});

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
