/**
 * Allocation comparison and schedule-window identity — the two pure
 * foundations of the sync's idempotency story.
 */

import { describe, expect, it } from "vitest";
import { allocationsEqual } from "@vex-agent/sync/z500-allocation-sync/compare.js";
import { computeWindow } from "@vex-agent/sync/z500-allocation-sync/window.js";

const SOL = "So11111111111111111111111111111111111111112";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

describe("allocationsEqual", () => {
  it("is insensitive to entry ordering", () => {
    expect(allocationsEqual({ [SOL]: 60, [JUP]: 40 }, { [JUP]: 40, [SOL]: 60 })).toBe(true);
  });

  it("differs on a weight change, a mint swap, and a count change", () => {
    expect(allocationsEqual({ [SOL]: 60, [JUP]: 40 }, { [SOL]: 59, [JUP]: 41 })).toBe(false);
    expect(allocationsEqual({ [SOL]: 100 }, { [JUP]: 100 })).toBe(false);
    expect(allocationsEqual({ [SOL]: 60, [JUP]: 40 }, { [SOL]: 60 })).toBe(false);
  });

  it("cannot consult symbols or names — the input SHAPE carries neither", () => {
    // Type-level guarantee stated as a runtime fact: only mint keys and
    // weight values exist to compare.
    expect(allocationsEqual({ [` ${SOL} `]: 10 }, { [SOL]: 10 })).toBe(true);
  });
});

describe("computeWindow", () => {
  it("names the window by the scheduled UTC midnight, stable all day", () => {
    const morning = computeWindow(new Date("2026-08-28T00:03:00Z"));
    const evening = computeWindow(new Date("2026-08-28T23:59:59Z"));
    expect(morning.windowId).toBe("2026-08-28T00:00:00.000Z");
    expect(evening.windowId).toBe(morning.windowId);
  });

  it("classifies an on-time claim as scheduled and a late one as catch-up", () => {
    expect(computeWindow(new Date("2026-08-28T00:05:00Z")).triggerType).toBe("scheduled");
    expect(computeWindow(new Date("2026-08-28T09:00:00Z")).triggerType).toBe("catch-up");
  });

  it("different days are different windows", () => {
    expect(computeWindow(new Date("2026-08-27T12:00:00Z")).windowId)
      .not.toBe(computeWindow(new Date("2026-08-28T12:00:00Z")).windowId);
  });
});
