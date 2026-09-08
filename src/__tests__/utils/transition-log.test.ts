import { describe, expect, it } from "vitest";
import { createTransitionLog } from "@utils/transition-log.js";

describe("transition log", () => {
  it("emits first/change/reminder with the exact number of suppressed observations", () => {
    let now = 0;
    const log = createTransitionLog({ now: () => now });
    expect(log.observe("wallet-a", "timeout")).toEqual({ suppressedCount: 0 });
    for (now = 30_000; now < 300_000; now += 30_000) {
      expect(log.observe("wallet-a", "timeout")).toBeUndefined();
    }
    expect(log.observe("wallet-a", "timeout")).toEqual({ suppressedCount: 9 });
    expect(log.observe("wallet-a", "timeout")).toBeUndefined();
    expect(log.observe("wallet-a", "dns")).toEqual({ suppressedCount: 1 });
    expect(log.observe("wallet-b", "dns")).toEqual({ suppressedCount: 0 });
    expect(log.observe("wallet-a", "dns")).toBeUndefined();
    expect(log.clear("wallet-a")).toEqual({ suppressedCount: 1 });
    expect(log.clear("wallet-a")).toBeUndefined();
    expect(log.observe("wallet-a", "dns")).toEqual({ suppressedCount: 0 });
  });

  it("keeps a twelve-hour thirty-second incident to 145 lines with accounted suppression", () => {
    let now = 0;
    const log = createTransitionLog({ now: () => now });
    let emitted = 0;
    let suppressed = 0;
    for (; now <= 12 * 60 * 60_000; now += 30_000) {
      const observation = log.observe("incident", "http_429");
      if (observation) { emitted++; suppressed += observation.suppressedCount; }
    }
    expect(emitted).toBe(145); // Initial observation plus 144 five-minute reminders.
    expect(emitted + suppressed).toBe(1441);
  });

  it("evicts the least recently observed key at its capacity and handles clock rollback", () => {
    let now = 100;
    const log = createTransitionLog({ maxEntries: 2, now: () => now });
    log.observe("a", "failed");
    log.observe("b", "failed");
    expect(log.observe("a", "failed")).toBeUndefined();
    log.observe("c", "failed");
    expect(log.observe("a", "failed")).toBeUndefined();
    expect(log.observe("b", "failed")).toEqual({ suppressedCount: 0 });
    now = 0;
    expect(log.observe("b", "failed")).toEqual({ suppressedCount: 0 });
  });
});
