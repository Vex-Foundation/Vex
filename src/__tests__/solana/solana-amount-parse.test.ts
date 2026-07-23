/**
 * Solana amount string → atomic base units (no float intermediate).
 *
 * Pins the send-path contract: a positive-looking amount must not convert
 * to zero base units, and conversion must not use Number/Math.round.
 */

import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../errors.js";
import {
  parseDecimalToAtomic,
  parsePositiveDecimalToAtomic,
  parseSolAmount,
  parseSplAmount,
  SOL_DECIMALS,
  uiToTokenAmount,
} from "@tools/solana-ecosystem/shared/solana-validation.js";
import { validatePrepareParams } from "../../vex-agent/tools/internal/wallet/send/validation.js";

function codeOf(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

describe("parseDecimalToAtomic / parsePositiveDecimalToAtomic", () => {
  it("converts normal SOL amounts to exact lamports", () => {
    expect(parsePositiveDecimalToAtomic("0.001", SOL_DECIMALS)).toBe(1_000_000n);
    expect(parsePositiveDecimalToAtomic("0.1", SOL_DECIMALS)).toBe(100_000_000n);
    expect(parsePositiveDecimalToAtomic("1", SOL_DECIMALS)).toBe(1_000_000_000n);
    expect(parsePositiveDecimalToAtomic("1.5", SOL_DECIMALS)).toBe(1_500_000_000n);
    expect(parsePositiveDecimalToAtomic("0.000000001", SOL_DECIMALS)).toBe(1n);
  });

  it("converts normal SPL amounts at 6 decimals", () => {
    expect(parsePositiveDecimalToAtomic("1", 6)).toBe(1_000_000n);
    expect(parsePositiveDecimalToAtomic("1.25", 6)).toBe(1_250_000n);
    expect(parsePositiveDecimalToAtomic("0.000001", 6)).toBe(1n);
  });

  it("rejects amounts that cannot represent one base unit (SOL, 9 decimals)", () => {
    for (const amount of ["0.0000000004", "0.0000000001", "1e-12", "1e-10", "0"]) {
      expect(() => parsePositiveDecimalToAtomic(amount, SOL_DECIMALS)).toThrow();
      try {
        parsePositiveDecimalToAtomic(amount, SOL_DECIMALS);
      } catch (err) {
        expect(codeOf(err)).toBe(ErrorCodes.INVALID_AMOUNT);
      }
    }
  });

  it("rejects amounts that cannot represent one base unit (SPL, 6 decimals)", () => {
    for (const amount of ["0.0000004", "0.0000001", "1e-7", "0"]) {
      expect(() => parsePositiveDecimalToAtomic(amount, 6)).toThrow();
      try {
        parsePositiveDecimalToAtomic(amount, 6);
      } catch (err) {
        expect(codeOf(err)).toBe(ErrorCodes.INVALID_AMOUNT);
      }
    }
  });

  it("expands scientific notation without float (1e-9 SOL = 1 lamport)", () => {
    expect(parsePositiveDecimalToAtomic("1e-9", SOL_DECIMALS)).toBe(1n);
    expect(parsePositiveDecimalToAtomic("1E-9", SOL_DECIMALS)).toBe(1n);
  });

  it("allows zero via parseDecimalToAtomic but not parsePositiveDecimalToAtomic", () => {
    expect(parseDecimalToAtomic("0", SOL_DECIMALS)).toBe(0n);
    expect(parseDecimalToAtomic("0.0", SOL_DECIMALS)).toBe(0n);
    expect(() => parsePositiveDecimalToAtomic("0", SOL_DECIMALS)).toThrow();
  });

  it("rejects negative and malformed amounts", () => {
    expect(() => parseDecimalToAtomic("-1", SOL_DECIMALS)).toThrow();
    expect(() => parseDecimalToAtomic("not-a-number", SOL_DECIMALS)).toThrow();
    expect(() => parseDecimalToAtomic("", SOL_DECIMALS)).toThrow();
  });
});

describe("parseSolAmount / parseSplAmount", () => {
  it("returns exact lamports for SOL strings", () => {
    expect(parseSolAmount("0.001").lamports).toBe(1_000_000n);
    expect(parseSolAmount("1").lamports).toBe(1_000_000_000n);
  });

  it("returns exact atoms for SPL strings", () => {
    expect(parseSplAmount("1.25", 6).atomic).toBe(1_250_000n);
  });
});

describe("uiToTokenAmount", () => {
  it("rejects values that collapse to zero base units", () => {
    expect(() => uiToTokenAmount(4e-10, SOL_DECIMALS)).toThrow();
    expect(codeOf(
      (() => {
        try {
          uiToTokenAmount(4e-10, SOL_DECIMALS);
        } catch (err) {
          return err;
        }
      })(),
    )).toBe(ErrorCodes.INVALID_AMOUNT);
  });

  it("accepts one full base unit", () => {
    expect(uiToTokenAmount(1e-9, SOL_DECIMALS)).toBe(1n);
    expect(uiToTokenAmount(1, 6)).toBe(1_000_000n);
  });
});

describe("validatePrepareParams — Solana native zero-atomic guard", () => {
  const base = {
    network: "solana",
    to: "11111111111111111111111111111111",
    token: null as string | null,
  };

  it("rejects SOL amounts that cannot become one lamport before intent creation", () => {
    for (const amount of ["0.0000000004", "1e-12", "0.0000000001"]) {
      const result = validatePrepareParams({ ...base, amount });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.result.success).toBe(false);
      }
    }
  });

  it("accepts a normal SOL amount", () => {
    const result = validatePrepareParams({ ...base, amount: "0.001" });
    expect(result.ok).toBe(true);
  });

  it("still accepts SPL prepare without decimals (execute enforces atoms)", () => {
    // Without mint decimals at prepare we cannot convert — presence check only.
    // Sub-atomic SPL is rejected at execute via parsePositiveDecimalToAtomic.
    const result = validatePrepareParams({
      network: "solana",
      to: "11111111111111111111111111111111",
      amount: "0.0000004",
      token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
    expect(result.ok).toBe(true);
  });
});
