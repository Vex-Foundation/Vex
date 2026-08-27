/**
 * THE THRESHOLD ARITHMETIC OF THE CHECK PROJECTOR.
 *
 * The classifier's own suite proves the TABLE. This one proves the only thing
 * that decides which row that table is handed: the comparison of a provider's
 * decimal against a named threshold. It is a money-surface comparison - the
 * difference between `clear` and `flagged` on a token a user is about to buy -
 * so the boundary is tested exactly, on both units the two auditors report in,
 * one step either side and precisely on it.
 *
 * WHY THE RAW STRING IS THE SUBJECT. `normalizedPct` for a `fraction` is
 * `Number(raw) * 100`, and `0.05 * 100` is `5.000000000000001` in IEEE-754.
 * Every fixture here therefore carries the float the endpoint would really have
 * produced, so a comparison that fell back to it fails here rather than in
 * production.
 *
 * Every case drives the REAL chain: wire bundle, projector, classifier. A
 * fixture asserting the projector alone would not prove which chip a user sees.
 */

import { describe, expect, it } from "vitest";

import type { BoardDetailsBundle, BoardPercent } from "../../schemas/board-details.js";
import { boardDetailsBundleSchema } from "../../schemas/board-details.js";
import {
  TAX_HARD_PCT,
  TAX_RISK_PCT,
  safetyChecksFromBundle,
  type SafetyCheckRow,
} from "../safety-checks.js";
import { classifyBoardSafety } from "../safety-classifier.js";
import { cleanBundle, evidence, goPlusClean } from "./board-safety-fixtures.js";

/**
 * A percent exactly as the endpoint's `percent()` builds one: the provider's
 * own spelling in `raw`, and the float that spelling normalizes to. The float
 * is deliberately NOT hand-corrected; it is the hazard under test.
 */
function reported(raw: string, unit: "percent" | "fraction"): BoardPercent {
  const parsed = Number(raw);
  return {
    raw,
    normalizedPct: Number.isFinite(parsed) ? (unit === "fraction" ? parsed * 100 : parsed) : null,
    unit,
  };
}

/** The clean document with one goplus buy tax substituted. */
function withBuyTax(buyTaxPct: BoardPercent): BoardDetailsBundle {
  const clean = cleanBundle();
  return {
    ...clean,
    safety: { ...clean.safety, goplus: { ...goPlusClean(), buyTaxPct } },
  };
}

function checkFor(bundle: BoardDetailsBundle, id: string): SafetyCheckRow | undefined {
  return safetyChecksFromBundle(bundle).checks.find(
    (row) => row.id === id && row.source === "goplus",
  );
}

/** Both spellings of the same percent: what goplus sends and what quickintel sends. */
function bothUnits(percentRaw: string, fractionRaw: string): readonly BoardPercent[] {
  return [reported(percentRaw, "percent"), reported(fractionRaw, "fraction")];
}

describe("the elevated-tax threshold is strict and exact", () => {
  it.each(bothUnits("5", "0.05"))(
    "clears a tax of exactly TAX_RISK_PCT reported as %o",
    (buyTaxPct) => {
      // THE FLOAT HAZARD. For the fraction spelling `normalizedPct` is
      // 5.000000000000001, so any comparison that used it would call an
      // exactly-five-percent tax elevated and paint the token amber.
      const bundle = withBuyTax(buyTaxPct);
      expect(boardDetailsBundleSchema.safeParse(bundle).success).toBe(true);
      expect(checkFor(bundle, "buyTaxElevated")).toMatchObject({ verdict: "pass" });
      expect(checkFor(bundle, "buyTax")).toMatchObject({ verdict: "pass" });
      expect(classifyBoardSafety(evidence(bundle)).state).toBe("clear");
    },
  );

  it.each(bothUnits("5.00000001", "0.0500000001"))(
    "RED ON REVERT of the `TAX_RISK_PCT + 0.0000001` epsilon: flags a tax a hair above five, reported as %o",
    (buyTaxPct) => {
      // The defect this file exists for. The old threshold was 5.0000001, so
      // 5.00000001 - ten times closer to five - read as a PASS and the token
      // showed a clean chip. A11 row 8 says `tax > TAX_RISK_PCT`, full stop.
      const bundle = withBuyTax(buyTaxPct);
      expect(checkFor(bundle, "buyTaxElevated")).toMatchObject({ verdict: "fail" });
      expect(classifyBoardSafety(evidence(bundle))).toMatchObject({
        state: "flagged",
        row: 7,
      });
    },
  );

  it.each(bothUnits("4.99999999", "0.0499999999"))(
    "clears a tax a hair below five, reported as %o",
    (buyTaxPct) => {
      const bundle = withBuyTax(buyTaxPct);
      expect(checkFor(bundle, "buyTaxElevated")).toMatchObject({ verdict: "pass" });
      expect(classifyBoardSafety(evidence(bundle)).state).toBe("clear");
    },
  );
});

describe("the hard-tax threshold fails AT the number", () => {
  it.each(bothUnits("10", "0.1"))(
    "fails a tax of exactly TAX_HARD_PCT reported as %o",
    (buyTaxPct) => {
      const bundle = withBuyTax(buyTaxPct);
      expect(checkFor(bundle, "buyTax")).toMatchObject({ verdict: "fail" });
      expect(classifyBoardSafety(evidence(bundle))).toMatchObject({
        state: "flagged",
        row: 7,
      });
    },
  );

  it("keeps the two thresholds as two different constants", () => {
    // The strict row and the at-or-above row are not the same statement, and a
    // future surface saying "high tax" versus "extreme tax" needs both.
    expect(TAX_RISK_PCT).toBeLessThan(TAX_HARD_PCT);
  });
});

describe("exponent notation is part of the grammar, not an edge case", () => {
  it("reads a tax `String(Number)` rendered as `5e-7` as far below the threshold", () => {
    // `raw` is whatever the endpoint carried through, and `String(0.0000005)`
    // is "5e-7". A reader that treated the `e` as unparseable would turn a
    // negligible tax into a caution chip.
    const bundle = withBuyTax(reported("5e-7", "percent"));
    expect(checkFor(bundle, "buyTaxElevated")).toMatchObject({ verdict: "pass" });
    expect(classifyBoardSafety(evidence(bundle)).state).toBe("clear");
  });

  it("reads an exponent-spelled fraction of exactly five percent as exactly five", () => {
    const bundle = withBuyTax(reported("5e-2", "fraction"));
    expect(checkFor(bundle, "buyTaxElevated")).toMatchObject({ verdict: "pass" });
    expect(checkFor(bundle, "buyTax")).toMatchObject({ verdict: "pass" });
    expect(classifyBoardSafety(evidence(bundle)).state).toBe("clear");
  });
});

describe("a percent that cannot be read is unverified, never a pass", () => {
  it("makes an unreadable raw an unverified check and a caution chip", () => {
    // The honest outcome, and the same one the header states for
    // `unit: "unverified"`: a value whose scale could not be established is not
    // turned into a number and compared. Falling back to `normalizedPct` here
    // would reintroduce the float this comparison exists to avoid, and
    // returning no check at all would let an unreadable tax read as clean.
    const bundle = withBuyTax({ raw: "n/a", normalizedPct: null, unit: "percent" });
    expect(boardDetailsBundleSchema.safeParse(bundle).success).toBe(true);
    expect(checkFor(bundle, "buyTax")).toMatchObject({ verdict: "unverified" });
    expect(checkFor(bundle, "buyTaxElevated")).toMatchObject({ verdict: "unverified" });
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict).toMatchObject({ state: "unverified", row: 9 });
    expect(verdict.reasons).toContain("goplus.buyTax");
  });

  it("keeps `unit: \"unverified\"` behaving exactly as before", () => {
    const bundle = withBuyTax({ raw: "0.05", normalizedPct: null, unit: "unverified" });
    expect(checkFor(bundle, "buyTax")).toMatchObject({ verdict: "unverified" });
    expect(classifyBoardSafety(evidence(bundle))).toMatchObject({
      state: "unverified",
      row: 9,
    });
  });
});
