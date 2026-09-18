import { describe, expect, it } from "vitest";
import { candleCountdown } from "../chart-countdown.js";

describe("candleCountdown", () => {
  it("counts down to the next bar boundary of the resolution", () => {
    const now = Date.UTC(2026, 8, 18, 10, 12, 30);
    expect(candleCountdown("1m", now)).toBe("00:30");
    expect(candleCountdown("5m", now)).toBe("02:30");
    expect(candleCountdown("1h", now)).toBe("47:30");
    expect(candleCountdown("4h", now)).toBe("1:47:30");
    expect(candleCountdown("1d", now)).toBe("13:47:30");
  });

  it("aligns weekly bars to Monday", () => {
    // 2026-09-18 is a Friday: the week closes Monday 00:00 UTC.
    expect(candleCountdown("1w", Date.UTC(2026, 8, 18, 0, 0, 0))).toBe("72:00:00");
  });
});
