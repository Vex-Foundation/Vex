import { describe, it, expect } from "vitest";
import {
  computeBand,
  isPressureBarrier,
  isPressureCritical,
  pressureFraction,
  PRESSURE_WARNING_FRACTION,
  PRESSURE_BARRIER_FRACTION,
  PRESSURE_CRITICAL_FRACTION,
} from "../../../../vex-agent/engine/core/context-band.js";

describe("context-band / computeBand (PR2 cutover — 4-band)", () => {
  const LIMIT = 128_000;

  describe("normal band — tokenCount below WARNING (0.80)", () => {
    it("empty session (0 tokens) is normal", () => {
      expect(computeBand(0, LIMIT)).toBe("normal");
    });

    it("50% usage is normal", () => {
      expect(computeBand(LIMIT * 0.5, LIMIT)).toBe("normal");
    });

    it("just below warning threshold (79.99%) is normal", () => {
      expect(computeBand(LIMIT * 0.7999, LIMIT)).toBe("normal");
    });
  });

  describe("warning band — tokenCount in [0.80, 0.88)", () => {
    it("exactly at warning threshold (80%) is warning", () => {
      expect(computeBand(LIMIT * PRESSURE_WARNING_FRACTION, LIMIT)).toBe("warning");
    });

    it("85% usage is warning (was the old warning threshold; still pre-barrier)", () => {
      expect(computeBand(LIMIT * 0.85, LIMIT)).toBe("warning");
    });

    it("86% usage is warning", () => {
      expect(computeBand(LIMIT * 0.86, LIMIT)).toBe("warning");
    });

    it("just below barrier threshold (87.99%) is warning", () => {
      expect(computeBand(LIMIT * 0.8799, LIMIT)).toBe("warning");
    });
  });

  describe("barrier band — tokenCount in [0.88, 0.92)", () => {
    it("exactly at barrier threshold (88%) is barrier", () => {
      expect(computeBand(LIMIT * PRESSURE_BARRIER_FRACTION, LIMIT)).toBe("barrier");
    });

    it("90% usage is barrier", () => {
      expect(computeBand(LIMIT * 0.90, LIMIT)).toBe("barrier");
    });

    it("just below critical threshold (91.99%) is barrier", () => {
      expect(computeBand(LIMIT * 0.9199, LIMIT)).toBe("barrier");
    });
  });

  describe("critical band — tokenCount >= 0.92", () => {
    it("exactly at critical threshold (92%) is critical", () => {
      expect(computeBand(LIMIT * PRESSURE_CRITICAL_FRACTION, LIMIT)).toBe("critical");
    });

    it("95% usage is critical", () => {
      expect(computeBand(LIMIT * 0.95, LIMIT)).toBe("critical");
    });

    it("over 100% (past-limit) is still classified critical, not thrown", () => {
      expect(computeBand(LIMIT * 2, LIMIT)).toBe("critical");
    });
  });

  describe("degenerate inputs", () => {
    it("zero contextLimit falls back to normal (no division by zero)", () => {
      expect(computeBand(1000, 0)).toBe("normal");
    });

    it("negative contextLimit falls back to normal", () => {
      expect(computeBand(1000, -1)).toBe("normal");
    });

    it("negative tokenCount is treated as empty → normal", () => {
      expect(computeBand(-500, LIMIT)).toBe("normal");
    });

    it("NaN tokenCount falls back to normal", () => {
      expect(computeBand(Number.NaN, LIMIT)).toBe("normal");
    });

    it("Infinity contextLimit falls back to normal", () => {
      expect(computeBand(1000, Number.POSITIVE_INFINITY)).toBe("normal");
    });
  });

  describe("threshold constants", () => {
    it("warning = 0.80, barrier = 0.88, critical = 0.92", () => {
      expect(PRESSURE_WARNING_FRACTION).toBe(0.80);
      expect(PRESSURE_BARRIER_FRACTION).toBe(0.88);
      expect(PRESSURE_CRITICAL_FRACTION).toBe(0.92);
    });

    // Ordering invariant, not a restatement of the values above: `classifyPressure` tests the
    // thresholds top-down, so any future edit that inverts two of them mis-bands silently rather
    // than failing loudly. Kept separate so it survives a deliberate re-tuning of the numbers.
    it("bands are strictly ordered: 0 < WARNING < BARRIER < CRITICAL <= 1", () => {
      expect(PRESSURE_WARNING_FRACTION).toBeGreaterThan(0);
      expect(PRESSURE_WARNING_FRACTION).toBeLessThan(PRESSURE_BARRIER_FRACTION);
      expect(PRESSURE_BARRIER_FRACTION).toBeLessThan(PRESSURE_CRITICAL_FRACTION);
      expect(PRESSURE_CRITICAL_FRACTION).toBeLessThanOrEqual(1);
    });
  });
});

describe("isPressureBarrier helper", () => {
  it("normal and warning are not at barrier", () => {
    expect(isPressureBarrier("normal")).toBe(false);
    expect(isPressureBarrier("warning")).toBe(false);
  });
  it("barrier and critical are at barrier", () => {
    expect(isPressureBarrier("barrier")).toBe(true);
    expect(isPressureBarrier("critical")).toBe(true);
  });
});

describe("isPressureCritical helper", () => {
  it("only critical is critical", () => {
    expect(isPressureCritical("normal")).toBe(false);
    expect(isPressureCritical("warning")).toBe(false);
    expect(isPressureCritical("barrier")).toBe(false);
    expect(isPressureCritical("critical")).toBe(true);
  });
});

describe("pressureFraction", () => {
  const LIMIT = 100_000;
  it("0 tokens → 0", () => {
    expect(pressureFraction(0, LIMIT)).toBe(0);
  });
  it("half → 0.5", () => {
    expect(pressureFraction(LIMIT * 0.5, LIMIT)).toBeCloseTo(0.5);
  });
  it("over-limit clamps to 1", () => {
    expect(pressureFraction(LIMIT * 3, LIMIT)).toBe(1);
  });
  it("zero limit → 0 (no division by zero)", () => {
    expect(pressureFraction(1000, 0)).toBe(0);
  });
  it("NaN tokenCount → 0", () => {
    expect(pressureFraction(Number.NaN, LIMIT)).toBe(0);
  });
});
