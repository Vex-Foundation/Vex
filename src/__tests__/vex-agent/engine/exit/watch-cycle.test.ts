/**
 * Pins the per-tick watch orchestrator.
 *
 * `runWatchCycle` is the pure layer between the rule engine and any real
 * polling loop: it refreshes each position's high-water peak, runs
 * `evaluateExit` against it, and returns one alert per position describing
 * what fired and which peak the caller should persist.
 *
 * The invariant that earns this its own module is FAULT ISOLATION: pricing is
 * the flakiest input in the system, so a missing, garbage or *throwing* price
 * lookup must degrade to a `price_unavailable` alert for that one token and
 * leave every other position in the sweep untouched.
 */
import { describe, expect, it, vi } from "vitest";

import type { ExitConfig } from "../../../../vex-agent/engine/exit/exit-rules.js";
import {
  runWatchCycle,
  type WatchInputPosition,
} from "../../../../vex-agent/engine/exit/watch-cycle.js";

const NOW = 1_700_000_000_000;

const CONFIG: ExitConfig = {
  takeProfitLadder: [{ multiple: 2, sellFraction: 0.5 }],
  stopLossPct: 0.35,
  trailingStopPct: 0.25,
  timeStopMinutes: 120,
  timeStopFlatBandPct: 0.15,
};

function input(overrides: Partial<WatchInputPosition> = {}): WatchInputPosition {
  return {
    token: "0xtoken",
    entryPriceUsd: 1,
    amountTokens: 1_000,
    openedAtMs: NOW,
    consumedRungs: [],
    priorPeakPriceUsd: 1,
    ...overrides,
  };
}

describe("runWatchCycle — peak tracking", () => {
  it("ratchets the peak up when the new price exceeds the carried high-water mark", () => {
    const [alert] = runWatchCycle([input()], () => 1.8, NOW, CONFIG);

    expect(alert?.updatedPeakPriceUsd).toBe(1.8);
    expect(alert?.currentPriceUsd).toBe(1.8);
  });

  it("keeps the carried peak when price falls back", () => {
    const [alert] = runWatchCycle([input({ priorPeakPriceUsd: 4 })], () => 2.5, NOW, CONFIG);

    expect(alert?.updatedPeakPriceUsd).toBe(4);
  });
});

describe("runWatchCycle — decision surfacing", () => {
  it("surfaces a take-profit decision when a rung is crossed", () => {
    const [alert] = runWatchCycle([input()], () => 2, NOW, CONFIG);

    expect(alert?.decisions).toMatchObject([{ kind: "take_profit", rungIndex: 0 }]);
  });

  it("surfaces a stop-loss decision when the stop is crossed", () => {
    const [alert] = runWatchCycle([input()], () => 0.5, NOW, CONFIG);

    expect(alert?.decisions).toMatchObject([{ kind: "stop_loss" }]);
  });

  it("reports an empty decision list when nothing fires", () => {
    const [alert] = runWatchCycle([input()], () => 1.1, NOW, CONFIG);

    expect(alert?.decisions).toEqual([]);
    expect(alert?.note).toBeUndefined();
  });

  it("evaluates the rules against the REFRESHED peak, not the stale one", () => {
    // Peak carried as 1, price spikes to 4, then the trailing stop is measured
    // from 4 — so a same-tick price of 4 cannot itself trip the trail.
    const [alert] = runWatchCycle(
      [input({ consumedRungs: [0], priorPeakPriceUsd: 1 })],
      () => 4,
      NOW,
      CONFIG,
    );

    expect(alert?.updatedPeakPriceUsd).toBe(4);
    expect(alert?.decisions).toEqual([]);
  });

  it("returns one alert per position, in input order", () => {
    const alerts = runWatchCycle(
      [input({ token: "A" }), input({ token: "B" }), input({ token: "C" })],
      () => 1.1,
      NOW,
      CONFIG,
    );

    expect(alerts.map((a) => a.token)).toEqual(["A", "B", "C"]);
  });

  it("returns nothing for an empty sweep", () => {
    expect(runWatchCycle([], () => 1, NOW, CONFIG)).toEqual([]);
  });
});

describe("runWatchCycle — price fault isolation", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -1],
  ])("degrades a %s price to a price_unavailable alert", (_label, price) => {
    const [alert] = runWatchCycle(
      [input({ priorPeakPriceUsd: 3 })],
      () => price as number,
      NOW,
      CONFIG,
    );

    expect(alert).toMatchObject({
      currentPriceUsd: null,
      decisions: [],
      note: "price_unavailable",
      updatedPeakPriceUsd: 3,
    });
  });

  it("does not let a throwing price lookup abort the sweep", () => {
    const priceOf = vi.fn((token: string) => {
      if (token === "B") throw new Error("provider down");
      return 2;
    });

    const alerts = runWatchCycle(
      [input({ token: "A" }), input({ token: "B" }), input({ token: "C" })],
      priceOf,
      NOW,
      CONFIG,
    );

    expect(alerts).toHaveLength(3);
    expect(alerts[1]).toMatchObject({ token: "B", note: "price_unavailable", decisions: [] });
    // Neighbours still evaluated normally.
    expect(alerts[0]?.decisions).toMatchObject([{ kind: "take_profit" }]);
    expect(alerts[2]?.decisions).toMatchObject([{ kind: "take_profit" }]);
  });

  it("never proposes an exit on a stale position it could not price", () => {
    const [alert] = runWatchCycle([input({ consumedRungs: [] })], () => null, NOW, CONFIG);

    expect(alert?.decisions).toEqual([]);
  });
});
