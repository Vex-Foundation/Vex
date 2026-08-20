/**
 * headTailCap boundary tests: the exact cap edge, over-cap splits (odd and
 * even maxLines), and the expanded uncap.
 */

import { describe, expect, it } from "vitest";
import { headTailCap } from "../head-tail-cap.js";

describe("headTailCap", () => {
  it("a list at or under the cap hides nothing", () => {
    expect(headTailCap(10, 10, false)).toEqual({
      hidden: 0,
      capped: false,
      headLines: 5,
      tailLines: 5,
    });
    expect(headTailCap(3, 10, false).capped).toBe(false);
    expect(headTailCap(3, 10, false).hidden).toBe(-7);
  });

  it("one row over the cap starts capping", () => {
    const cap = headTailCap(11, 10, false);
    expect(cap.capped).toBe(true);
    expect(cap.hidden).toBe(1);
  });

  it("odd maxLines gives the head the extra row", () => {
    const cap = headTailCap(100, 7, false);
    expect(cap.headLines).toBe(4);
    expect(cap.tailLines).toBe(3);
    expect(cap.headLines + cap.tailLines).toBe(7);
  });

  it("expanded uncaps but keeps the metrics", () => {
    const cap = headTailCap(100, 10, true);
    expect(cap.capped).toBe(false);
    expect(cap.hidden).toBe(90);
    expect(cap.headLines).toBe(5);
    expect(cap.tailLines).toBe(5);
  });
});
