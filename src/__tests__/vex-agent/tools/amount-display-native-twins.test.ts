/**
 * The native-unit display twins (U2).
 *
 * Rule 90: "raw amounts must travel with the decimals needed to read them".
 * Gas prices in wei and Solana fees in lamports are the two figures whose bare
 * integer reads as a plausible number in the LARGER unit, so an agent that
 * skips the suffix is wrong by a factor of a billion (SOL) or a thousand (the
 * gwei case that motivated this).
 *
 * These functions are DISPLAY-only and never throw: on a display path a missing
 * amount is safer than a wrong one.
 */

import { describe, it, expect } from "vitest";
import {
  formatWeiAsGwei,
  formatLamportsAsSol,
} from "../../../vex-agent/tools/protocols/amount-display.js";

describe("formatWeiAsGwei", () => {
  // The trap: 22518000 reads as "22.5 gwei" to anyone who skips the suffix.
  it("reads 22518000 wei as 0.022518 gwei, not 22.5", () => {
    expect(formatWeiAsGwei("22518000")).toBe("0.022518");
  });

  it("reads one gwei", () => {
    expect(formatWeiAsGwei(1_000_000_000n)).toBe("1");
  });

  it("keeps sub-gwei precision rather than rounding it away", () => {
    expect(formatWeiAsGwei("1")).toBe("0.000000001");
  });

  it("yields null rather than a guess for missing or malformed input", () => {
    expect(formatWeiAsGwei(null)).toBeNull();
    expect(formatWeiAsGwei(undefined)).toBeNull();
    expect(formatWeiAsGwei("not a number")).toBeNull();
  });
});

describe("formatLamportsAsSol", () => {
  it("reads the default Jupiter tip as 0.001 SOL", () => {
    expect(formatLamportsAsSol(1_000_000)).toBe("0.001");
  });

  it("reads an ATA rent figure exactly", () => {
    expect(formatLamportsAsSol(2_039_280)).toBe("0.00203928");
  });

  it("accepts a bigint and a string as well as a number", () => {
    expect(formatLamportsAsSol(200n)).toBe("0.0000002");
    expect(formatLamportsAsSol("200")).toBe("0.0000002");
  });

  it("yields null for missing, fractional or unsafe numeric input", () => {
    expect(formatLamportsAsSol(null)).toBeNull();
    expect(formatLamportsAsSol(undefined)).toBeNull();
    expect(formatLamportsAsSol(1.5)).toBeNull();
    expect(formatLamportsAsSol(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });
});
