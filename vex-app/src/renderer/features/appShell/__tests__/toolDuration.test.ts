/**
 * Duration chip copy. The load-bearing case is NULL vs ZERO: a call that never
 * executed carries `null` and must print NOTHING, while a genuinely
 * instantaneous call carries a measured `0` and prints "0 ms". Collapsing the
 * two would tell the operator a call ran when it did not.
 */

import { describe, expect, it } from "vitest";
import { formatToolDuration } from "../ToolLedger/toolDuration.js";

describe("formatToolDuration", () => {
  it("prints nothing for null — a not-run call must never read as 0 s", () => {
    expect(formatToolDuration(null)).toBeNull();
  });

  it("prints a MEASURED zero as 0 ms", () => {
    expect(formatToolDuration(0)).toBe("0 ms");
  });

  it("prints sub-second measurements in whole milliseconds", () => {
    expect(formatToolDuration(1)).toBe("1 ms");
    expect(formatToolDuration(420)).toBe("420 ms");
    expect(formatToolDuration(999)).toBe("999 ms");
  });

  it("prints seconds with one decimal from 1s up", () => {
    expect(formatToolDuration(1_000)).toBe("1.0 s");
    expect(formatToolDuration(2_340)).toBe("2.3 s");
    expect(formatToolDuration(59_900)).toBe("59.9 s");
  });

  it("prints minutes and seconds past a minute", () => {
    expect(formatToolDuration(60_000)).toBe("1m 00s");
    expect(formatToolDuration(65_400)).toBe("1m 05s");
  });

  it("rejects impossible values rather than printing nonsense", () => {
    expect(formatToolDuration(-1)).toBeNull();
    expect(formatToolDuration(Number.NaN)).toBeNull();
    expect(formatToolDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
