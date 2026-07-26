/**
 * `borrow-health.ts` — the LTV / liquidation-distance math behind
 * `solana.lend.borrowPositions` (W4).
 *
 * Owner decision 2026-07-25: DISCLOSE, DO NOT BLOCK. In a `full` autonomous
 * session there is no approval preview and no human, so this computation IS
 * the safety control. The tests below therefore pin two things equally hard:
 * that a computable LTV is computed CORRECTLY from known inputs, and that an
 * uncomputable one is reported as an explicitly NAMED unknown state — never a
 * silently absent field, never a fabricated number, never something an agent
 * could read as "safe".
 */

import { describe, expect, it } from "vitest";
import {
  computeBorrowPositionRisk,
  formatTenthsAsPercent,
  parseTenthsAsPercentNumber,
  readLiquidationStatus,
  sumRawDebt,
  type BorrowPositionRiskInput,
} from "@vex-agent/tools/protocols/solana-jupiter/borrow-health.js";

/**
 * 1 WSOL (9 decimals) collateral at $100 = $100; 50 USDC (6 decimals) debt at
 * $1 = $50 → LTV exactly 50.00%, 35.00 percentage points below the 85.0%
 * liquidation threshold. Deliberately exact so a decimals or leg mix-up
 * cannot round itself into looking right.
 */
const BASE: BorrowPositionRiskInput = {
  vaultId: "1",
  collateralRaw: "1000000000",
  collateralDecimals: 9,
  collateralPriceUsd: "100",
  debtRaw: "50000000",
  debtDecimals: 6,
  debtPriceUsd: "1",
  liquidationThresholdRaw: "850",
};

describe("readLiquidationStatus", () => {
  it("distinguishes liquidated, not-liquidated, and NOT REPORTED", () => {
    expect(readLiquidationStatus(true)).toBe("liquidated");
    expect(readLiquidationStatus(false)).toBe("not_liquidated");
    // The provider omitting the flag must NEVER read as "not liquidated" —
    // the recorded live fixture is an empty array, so the field's presence on
    // a real row is documented but not confirmed.
    expect(readLiquidationStatus(undefined)).toBe("unknown");
    expect(readLiquidationStatus(null)).toBe("unknown");
  });
});

describe("percent scale helpers", () => {
  it("formats the provider's raw/10 scale exactly, by digit shifting", () => {
    expect(formatTenthsAsPercent("850")).toBe("85.0%");
    expect(formatTenthsAsPercent("800")).toBe("80.0%");
    expect(formatTenthsAsPercent("5")).toBe("0.5%");
  });

  it("degrades to null for a malformed raw value rather than inventing a percent", () => {
    expect(formatTenthsAsPercent("not-a-number")).toBeNull();
    expect(parseTenthsAsPercentNumber("not-a-number")).toBeNull();
  });

  it("parses the same scale as a number for distance arithmetic", () => {
    expect(parseTenthsAsPercentNumber("850")).toBe(85);
    expect(parseTenthsAsPercentNumber("940")).toBe(94);
  });
});

describe("sumRawDebt", () => {
  it("adds accrued dust to the principal with bigint math, never Number", () => {
    // Beyond MAX_SAFE_INTEGER on purpose: a Number-based sum silently loses
    // the last digits here.
    expect(sumRawDebt("9007199254740993", "9")).toBe("9007199254741002");
    expect(sumRawDebt("5000000", "5001")).toBe("5005001");
  });

  it("returns null for a non-digit amount instead of throwing out of the read", () => {
    expect(sumRawDebt("5000000", "oops")).toBeNull();
  });
});

describe("computeBorrowPositionRisk — computable", () => {
  it("computes LTV and the distance to liquidation from each leg's OWN decimals", () => {
    const risk = computeBorrowPositionRisk(BASE);
    expect(risk).toEqual({
      status: "computed",
      collateralUsd: "100.00",
      debtUsd: "50.00",
      currentLtvPercent: "50.00%",
      ltvPercentagePointsToLiquidation: "35.00",
    });
  });

  it("does not mix the two legs' decimals up (the 1000x hazard)", () => {
    // Same raw amounts, legs swapped: 1 USDC-scale unit of a 9-decimal token
    // is a thousandfold different amount. A projector reading the wrong leg's
    // decimals would still produce "50.00%" above but cannot produce this.
    const risk = computeBorrowPositionRisk({
      ...BASE,
      collateralRaw: "1000000000", collateralDecimals: 6, collateralPriceUsd: "1",
      debtRaw: "50000000", debtDecimals: 9, debtPriceUsd: "100",
    });
    // collateral 1000 USDC = $1000; debt 0.05 WSOL = $5 → 0.50%
    expect(risk).toMatchObject({ collateralUsd: "1000.00", debtUsd: "5.00", currentLtvPercent: "0.50%" });
  });

  it("reports a position already past its liquidation threshold as a NEGATIVE distance", () => {
    const risk = computeBorrowPositionRisk({ ...BASE, debtRaw: "90000000" }); // $90 debt on $100
    expect(risk).toMatchObject({
      status: "computed",
      currentLtvPercent: "90.00%",
      ltvPercentagePointsToLiquidation: "-5.00",
    });
  });

  it("an empty position is 0.00% LTV, not unknown", () => {
    const risk = computeBorrowPositionRisk({ ...BASE, collateralRaw: "0", debtRaw: "0" });
    expect(risk).toMatchObject({ status: "computed", currentLtvPercent: "0.00%", ltvPercentagePointsToLiquidation: "85.00" });
  });

  it("never rounds a real but tiny USD value down to a bare 0.00", () => {
    const risk = computeBorrowPositionRisk({ ...BASE, debtRaw: "1" }); // 0.000001 USDC
    expect(risk).toMatchObject({ status: "computed", debtUsd: "<0.01" });
  });
});

describe("computeBorrowPositionRisk — named non-computable states", () => {
  it("debt with ZERO collateral is its own named state, never 'unknown' and never a ratio", () => {
    const risk = computeBorrowPositionRisk({ ...BASE, collateralRaw: "0" });
    expect(risk.status).toBe("undercollateralized");
    if (risk.status !== "undercollateralized") throw new Error("unreachable");
    expect(risk.debtUsd).toBe("50.00");
    expect(risk.note).toMatch(/past liquidation/i);
  });

  it("an unusable provider price yields status 'unknown' with a reason naming the leg", () => {
    const risk = computeBorrowPositionRisk({ ...BASE, collateralPriceUsd: "" });
    expect(risk.status).toBe("unknown");
    if (risk.status !== "unknown") throw new Error("unreachable");
    expect(risk.reason).toMatch(/collateral/i);
    expect(risk.reason).toMatch(/not a statement that this position is safe/i);
  });

  it("a zero or negative price is unusable, not a valuation of zero", () => {
    expect(computeBorrowPositionRisk({ ...BASE, collateralPriceUsd: "0" }).status).toBe("unknown");
    expect(computeBorrowPositionRisk({ ...BASE, debtPriceUsd: "-1" }).status).toBe("unknown");
  });

  it("an unreadable liquidation threshold yields 'unknown' — the distance is the point of the field", () => {
    const risk = computeBorrowPositionRisk({ ...BASE, liquidationThresholdRaw: "n/a" });
    expect(risk.status).toBe("unknown");
    if (risk.status !== "unknown") throw new Error("unreachable");
    expect(risk.reason).toMatch(/liquidation threshold/i);
  });

  it("an amount too large to value in floating point degrades instead of drifting", () => {
    const risk = computeBorrowPositionRisk({ ...BASE, collateralRaw: "1".repeat(20) });
    expect(risk.status).toBe("unknown");
    if (risk.status !== "unknown") throw new Error("unreachable");
    expect(risk.reason).toMatch(/too large/i);
  });

  it("a malformed raw amount degrades instead of throwing out of the read", () => {
    const risk = computeBorrowPositionRisk({ ...BASE, debtRaw: "1.5" });
    expect(risk.status).toBe("unknown");
  });

  it("every 'unknown' reason warns that unknown is not safe", () => {
    const unknowns = [
      computeBorrowPositionRisk({ ...BASE, collateralPriceUsd: "x" }),
      computeBorrowPositionRisk({ ...BASE, debtPriceUsd: "x" }),
      computeBorrowPositionRisk({ ...BASE, liquidationThresholdRaw: "x" }),
      computeBorrowPositionRisk({ ...BASE, collateralRaw: "1".repeat(20) }),
      computeBorrowPositionRisk({ ...BASE, debtRaw: "1.5" }),
    ];
    for (const risk of unknowns) {
      expect(risk.status).toBe("unknown");
      if (risk.status !== "unknown") throw new Error("unreachable");
      expect(risk.reason).toMatch(/not a statement that this position is safe/i);
    }
  });
});

/**
 * PEER-REVIEW DEFECT, 2026-07-25: individual INPUTS were validated for
 * finiteness but the products and the quotient built out of them were not, so a
 * degenerate combination emitted `currentLtvPercent: "NaN%"` — or `"Infinity%"`
 * — under `status: "computed"`, the discriminant that tells an autonomous agent
 * the number is USABLE. Under DISCLOSE-DO-NOT-BLOCK there is no gate behind
 * this output to catch it: the agent sizes a borrow off whatever it reads.
 *
 * `decimals` and the prices arrive on a provider JSON row typed only by a
 * compile-time `interface` (`jupiter-lend/borrow-api/types.ts`), so none of
 * these shapes are hypothetical — they are what an untyped wire field can carry.
 *
 * Each test below reaches a DIFFERENT arithmetic step, because a single guard
 * at one step does not cover the others.
 */
describe("computeBorrowPositionRisk — non-finite arithmetic can never reach 'computed'", () => {
  it("a decimals value that cannot scale a raw amount is a named unknown, not a valuation", () => {
    // `10 ** NaN` is `NaN`: every USD figure derived from it is NaN.
    const risk = computeBorrowPositionRisk({ ...BASE, collateralDecimals: Number.NaN });
    expect(risk.status).toBe("unknown");
    if (risk.status !== "unknown") throw new Error("unreachable");
    expect(risk.reason).toMatch(/decimals/i);
    expect(risk.reason).toMatch(/not a statement that this position is safe/i);
  });

  it("a decimals value whose scale overflows does NOT silently report the position as empty", () => {
    // `10 ** 400` is `Infinity`, so `raw / Infinity` is `0` — FINITE, and
    // therefore survives a result-only finiteness check while reporting a real
    // 1 WSOL of collateral and 50 USDC of debt as 0.00% LTV, 85 points clear.
    // That fabrication is worse than the NaN it replaces.
    const risk = computeBorrowPositionRisk({ ...BASE, collateralDecimals: 400, debtDecimals: 400 });
    expect(risk.status).toBe("unknown");
    if (risk.status !== "unknown") throw new Error("unreachable");
    expect(risk.reason).toMatch(/decimals/i);
  });

  it("a valuation that overflows to non-finite is a named unknown, not a computed USD figure", () => {
    // Divisor `10 ** -323` is finite and positive, so a decimals guard alone
    // admits it — but 999,999,999,999,999 / 1e-323 overflows to Infinity.
    const risk = computeBorrowPositionRisk({
      ...BASE,
      collateralRaw: "999999999999999",
      collateralDecimals: -323,
    });
    expect(risk.status).toBe("unknown");
    if (risk.status !== "unknown") throw new Error("unreachable");
    expect(risk.reason).toMatch(/not a statement that this position is safe/i);
  });

  it("an LTV ratio that overflows is a named unknown — never the string 'Infinity%'", () => {
    // Both USD figures are finite: collateral 1e-320 (a denormal, still > 0),
    // debt 1e12. Their QUOTIENT is Infinity, and only a check on the quotient
    // catches it.
    const risk = computeBorrowPositionRisk({
      ...BASE,
      collateralRaw: "1", collateralDecimals: 300, collateralPriceUsd: "1e-20",
      debtRaw: "1000000", debtDecimals: 0, debtPriceUsd: "1000000",
    });
    expect(risk.status).toBe("unknown");
    if (risk.status !== "unknown") throw new Error("unreachable");
    expect(risk.reason).toMatch(/not a statement that this position is safe/i);
  });

  /**
   * The invariant, stated once over every shape: no field an agent reads as a
   * MEASUREMENT ever carries `NaN` or `Infinity`. Asserted on the emitted
   * strings, because `"NaN%"` is what actually reached the agent — not on the
   * intermediate floats.
   *
   * `reason`/`note` are deliberately exempt. They are diagnostics, and echoing
   * the provider's own broken value back ("collateral NaN") is the honest
   * report of what arrived; suppressing it would hide the cause. The danger was
   * never the characters, it was a fabricated number under `status: "computed"`.
   */
  it("no input produces a measurement field carrying NaN or Infinity", () => {
    const hostile: readonly Partial<BorrowPositionRiskInput>[] = [
      { collateralDecimals: Number.NaN },
      { debtDecimals: Number.NaN },
      { collateralDecimals: 400 },
      { debtDecimals: 400 },
      { collateralDecimals: -400 },
      { debtDecimals: -400 },
      { collateralDecimals: Number.POSITIVE_INFINITY },
      { collateralRaw: "999999999999999", collateralDecimals: -323 },
      { debtRaw: "999999999999999", debtDecimals: -323 },
      {
        collateralRaw: "1", collateralDecimals: 300, collateralPriceUsd: "1e-20",
        debtRaw: "1000000", debtDecimals: 0, debtPriceUsd: "1000000",
      },
    ];
    // Healthy shapes ride along so the `computed` branch is covered by the same
    // invariant — otherwise a regression that deleted a guard would be caught
    // only by the status assertion.
    const healthy: readonly Partial<BorrowPositionRiskInput>[] = [
      {},
      { debtRaw: "0" },
      { collateralRaw: "0" },
      { collateralDecimals: 0, collateralRaw: "100", collateralPriceUsd: "1" },
    ];

    for (const patch of [...hostile, ...healthy]) {
      const risk = computeBorrowPositionRisk({ ...BASE, ...patch });
      const measurements = risk.status === "unknown"
        ? []
        : risk.status === "undercollateralized"
          ? [risk.collateralUsd, risk.debtUsd]
          : [risk.collateralUsd, risk.debtUsd, risk.currentLtvPercent, risk.ltvPercentagePointsToLiquidation];
      for (const measurement of measurements) {
        expect(measurement).not.toMatch(/NaN|Infinity/);
      }
    }

    for (const patch of hostile) {
      expect(computeBorrowPositionRisk({ ...BASE, ...patch }).status).not.toBe("computed");
    }
  });

  it("still computes the ordinary position — the guards refuse degenerate input, not healthy input", () => {
    expect(computeBorrowPositionRisk(BASE)).toEqual({
      status: "computed",
      collateralUsd: "100.00",
      debtUsd: "50.00",
      currentLtvPercent: "50.00%",
      ltvPercentagePointsToLiquidation: "35.00",
    });
    // Zero decimals is legitimate (a 0-decimal SPL mint), not a degenerate scale.
    expect(computeBorrowPositionRisk({
      ...BASE,
      collateralRaw: "100", collateralDecimals: 0, collateralPriceUsd: "1",
      debtRaw: "50", debtDecimals: 0, debtPriceUsd: "1",
    })).toMatchObject({ status: "computed", currentLtvPercent: "50.00%" });
  });
});
