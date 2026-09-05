/**
 * Pins the exit-rule engine's decision contract.
 *
 * `evaluateExit` is the pure core of the exit engine: given a position, a
 * price, a clock reading (passed IN, never read here) and a static config, it
 * returns the exit decisions that fire on this tick. It decides NOTHING about
 * execution — a decision is a proposal, and every caller routes it through the
 * app's existing approval path.
 *
 * Two invariants matter most and are asserted throughout:
 *   - PURITY: same inputs → same output, no I/O, no Date.now, no randomness.
 *   - TOTALITY: it never throws. Garbage price/entry, a malformed ladder, or a
 *     fully-consumed position yields `[]` — a documented "do nothing" — so a
 *     single bad price tick can never take down the watch loop that calls it.
 */
import { describe, expect, it } from "vitest";

import {
  evaluateExit,
  type ExitConfig,
  type Position,
} from "../../../../vex-agent/engine/exit/exit-rules.js";

const MINUTE_MS = 60_000;
const OPENED_AT = 1_700_000_000_000;

/** Ladder: sell half at 2x, half at 3x. Stop 35%. Trail 25%. */
const CONFIG: ExitConfig = {
  takeProfitLadder: [
    { multiple: 2, sellFraction: 0.5 },
    { multiple: 3, sellFraction: 0.5 },
  ],
  stopLossPct: 0.35,
  trailingStopPct: 0.25,
  timeStopMinutes: 120,
  timeStopFlatBandPct: 0.15,
};

function position(overrides: Partial<Position> = {}): Position {
  return {
    token: "0xtoken",
    entryPriceUsd: 1,
    amountTokens: 1_000,
    peakPriceUsd: 1,
    openedAtMs: OPENED_AT,
    consumedRungs: [],
    ...overrides,
  };
}

describe("evaluateExit — take-profit ladder", () => {
  it("fires the first rung when price reaches the 2x multiple", () => {
    const decisions = evaluateExit(position(), 2, OPENED_AT, CONFIG);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "take_profit",
      rungIndex: 0,
      sellFraction: 0.5,
    });
  });

  it("does not re-fire a rung already recorded as consumed (idempotent)", () => {
    const decisions = evaluateExit(
      position({ consumedRungs: [0] }),
      2,
      OPENED_AT,
      CONFIG,
    );

    expect(decisions).toEqual([]);
  });

  it("fires both rungs at once when a single tick jumps past the whole ladder", () => {
    const decisions = evaluateExit(position(), 3.5, OPENED_AT, CONFIG);

    expect(decisions.map((d) => d.rungIndex)).toEqual([0, 1]);
    const total = decisions.reduce((sum, d) => sum + d.sellFraction, 0);
    expect(total).toBeCloseTo(1);
  });

  it("never sells more than the position — cumulative fraction is clamped to 1", () => {
    const greedy: ExitConfig = {
      ...CONFIG,
      takeProfitLadder: [
        { multiple: 2, sellFraction: 0.8 },
        { multiple: 3, sellFraction: 0.8 },
      ],
    };

    const decisions = evaluateExit(position(), 5, OPENED_AT, greedy);
    const total = decisions.reduce((sum, d) => sum + d.sellFraction, 0);

    expect(total).toBeLessThanOrEqual(1);
    expect(total).toBeCloseTo(1);
  });

  it("holds below the rung — a price just under 2x is a no-op", () => {
    expect(evaluateExit(position(), 1.99, OPENED_AT, CONFIG)).toEqual([]);
  });
});

describe("evaluateExit — stop-loss", () => {
  it("exits the full remaining position once price crosses the stop", () => {
    const decisions = evaluateExit(position(), 0.6, OPENED_AT, CONFIG);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: "stop_loss", sellFraction: 1 });
  });

  it("fires exactly at the threshold price (inclusive boundary)", () => {
    const decisions = evaluateExit(position(), 0.65, OPENED_AT, CONFIG);

    expect(decisions[0]?.kind).toBe("stop_loss");
  });

  it("sells only what is left when part of the ladder is already consumed", () => {
    const decisions = evaluateExit(
      position({ consumedRungs: [0] }),
      0.5,
      OPENED_AT,
      CONFIG,
    );

    expect(decisions[0]).toMatchObject({ kind: "stop_loss", sellFraction: 0.5 });
  });

  it("outranks take-profit — capital preservation wins a contradictory tick", () => {
    const contradictory: ExitConfig = { ...CONFIG, stopLossPct: -1 };

    const decisions = evaluateExit(position(), 2, OPENED_AT, contradictory);

    expect(decisions[0]?.kind).toBe("stop_loss");
  });
});

describe("evaluateExit — trailing stop", () => {
  it("stays disarmed until the ladder is in profit", () => {
    const decisions = evaluateExit(
      position({ peakPriceUsd: 1.5 }),
      1.1,
      OPENED_AT,
      CONFIG,
    );

    expect(decisions).toEqual([]);
  });

  // Price 2.5 is chosen so the two rules cannot be confused: it is at/below the
  // trail (peak 4 − 25% = 3) but below the 3x take-profit rung, so only the
  // trailing stop can explain a decision here.
  it("exits the remainder once armed and price falls the trail distance from peak", () => {
    const decisions = evaluateExit(
      position({ consumedRungs: [0], peakPriceUsd: 4 }),
      2.5,
      OPENED_AT,
      CONFIG,
    );

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "trailing_stop",
      sellFraction: 0.5,
    });
  });

  it("is skipped entirely when trailingStopPct is not configured", () => {
    const noTrail: ExitConfig = { ...CONFIG, trailingStopPct: undefined };

    const decisions = evaluateExit(
      position({ consumedRungs: [0], peakPriceUsd: 4 }),
      2.5,
      OPENED_AT,
      noTrail,
    );

    expect(decisions).toEqual([]);
  });
});

describe("evaluateExit — time stop", () => {
  it("rotates out of a flat position once the dwell time elapses", () => {
    const decisions = evaluateExit(
      position(),
      1.05,
      OPENED_AT + 120 * MINUTE_MS,
      CONFIG,
    );

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: "time_stop", sellFraction: 1 });
  });

  it("holds a position that is old but has broken out of the flat band", () => {
    const decisions = evaluateExit(
      position(),
      1.4,
      OPENED_AT + 120 * MINUTE_MS,
      CONFIG,
    );

    expect(decisions).toEqual([]);
  });

  it("holds a flat position that has not yet reached the dwell time", () => {
    const decisions = evaluateExit(
      position(),
      1.05,
      OPENED_AT + 10 * MINUTE_MS,
      CONFIG,
    );

    expect(decisions).toEqual([]);
  });
});

describe("evaluateExit — totality on bad data", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -5],
  ])("returns no decisions for a %s price rather than throwing", (_label, price) => {
    expect(() => evaluateExit(position(), price, OPENED_AT, CONFIG)).not.toThrow();
    expect(evaluateExit(position(), price, OPENED_AT, CONFIG)).toEqual([]);
  });

  it("returns no decisions when the entry price is missing or nonsensical", () => {
    expect(evaluateExit(position({ entryPriceUsd: 0 }), 2, OPENED_AT, CONFIG)).toEqual([]);
    expect(
      evaluateExit(position({ entryPriceUsd: Number.NaN }), 2, OPENED_AT, CONFIG),
    ).toEqual([]);
  });

  it("returns no decisions once the whole position has been sold", () => {
    expect(evaluateExit(position({ consumedRungs: [0, 1] }), 5, OPENED_AT, CONFIG)).toEqual(
      [],
    );
  });

  it("ignores out-of-range, duplicate and non-integer consumed-rung indices", () => {
    const decisions = evaluateExit(
      position({ consumedRungs: [-1, 99, 1.5, 0, 0] }),
      2,
      OPENED_AT,
      CONFIG,
    );

    // Only index 0 is a real consumed rung, so rung 0 must not re-fire and the
    // bogus indices must not have eaten any of the remaining capacity.
    expect(decisions).toEqual([]);
    expect(
      evaluateExit(position({ consumedRungs: [-1, 99, 1.5, 0, 0] }), 3, OPENED_AT, CONFIG),
    ).toMatchObject([{ kind: "take_profit", rungIndex: 1, sellFraction: 0.5 }]);
  });

  it("survives an empty ladder and a fully malformed config", () => {
    const empty: ExitConfig = {
      takeProfitLadder: [],
      stopLossPct: Number.NaN,
      timeStopMinutes: Number.NaN,
      timeStopFlatBandPct: Number.NaN,
    };

    expect(() => evaluateExit(position(), 2, OPENED_AT, empty)).not.toThrow();
    expect(evaluateExit(position(), 2, OPENED_AT, empty)).toEqual([]);
  });

  it("skips ladder rungs whose multiple or fraction is not a real number", () => {
    const malformed: ExitConfig = {
      ...CONFIG,
      takeProfitLadder: [
        { multiple: Number.NaN, sellFraction: 0.5 },
        { multiple: 2, sellFraction: Number.NaN },
      ],
    };

    expect(evaluateExit(position(), 10, OPENED_AT, malformed)).toEqual([]);
  });

  it("is deterministic — repeated evaluation of one tick yields an identical result", () => {
    const pos = position({ consumedRungs: [0], peakPriceUsd: 3 });
    const first = evaluateExit(pos, 2.5, OPENED_AT + MINUTE_MS, CONFIG);
    const second = evaluateExit(pos, 2.5, OPENED_AT + MINUTE_MS, CONFIG);

    expect(first).toEqual(second);
  });

  it("does not mutate the position or config it is given", () => {
    const pos = position({ consumedRungs: [0] });
    const posSnapshot = structuredClone(pos);
    const configSnapshot = structuredClone(CONFIG);

    evaluateExit(pos, 3, OPENED_AT, CONFIG);

    expect(pos).toEqual(posSnapshot);
    expect(CONFIG).toEqual(configSnapshot);
  });
});
