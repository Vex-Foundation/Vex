import { describe, it, expect } from "vitest";

import { assessMissionMeasurability } from "../../../../vex-agent/engine/mission/measurability.js";
import type { DeployedCapital } from "../../../../vex-agent/engine/types.js";

const DECLARED: DeployedCapital = {
  amountRaw: "10000000",
  decimals: 6,
  chainId: 4663,
  assetAddress: "0x0f9f0000000000000000000000000000000000ee",
  assetSymbol: "USDC",
};

function codes(draft: Parameters<typeof assessMissionMeasurability>[0]): string[] {
  return assessMissionMeasurability(draft).map((w) => w.code);
}

describe("mission measurability", () => {
  // ── The 2026-08-10 incident, verbatim ───────────────────────────
  //
  // This exact criterion is why the module exists: a relative gain with no
  // denominator AND an absolute portfolio target that pre-existing holdings
  // already nearly satisfied.
  const INCIDENT = "Portfolio value on Robinhood Chain reaches $15+ (50% gain on ~$10 deployed capital)";

  it("fires BOTH W1 and W2 on the incident criterion when nothing is declared", () => {
    expect(codes({ successCriteria: [INCIDENT] })).toEqual([
      "relative_target_without_deployed_capital",
      "absolute_portfolio_target_without_deployed_capital",
    ]);
  });

  it("clears W1 but KEEPS W2 once capital is declared", () => {
    // A declaration supplies the missing denominator (W1), but it does not
    // change what an absolute WHOLE-PORTFOLIO target means: a balance the
    // wallet already held still counts toward it. Silencing W2 here would
    // reproduce the incident with a typed field attached.
    expect(codes({ successCriteria: [INCIDENT], deployedCapital: DECLARED })).toEqual([
      "absolute_portfolio_target_without_deployed_capital",
    ]);
  });

  // ── W1: relative target without a denominator ───────────────────
  it("fires W1 for a percentage, a multiple, an ROI, or a doubling", () => {
    for (const text of ["Gain 50%", "Achieve a 3x return", "Positive ROI by Friday", "Double the wallet"]) {
      expect(codes({ successCriteria: [text] })).toContain("relative_target_without_deployed_capital");
    }
  });

  it("fires W1 from the goal, not just the criteria", () => {
    expect(codes({ goal: "Double the stack", successCriteria: ["Hold 10 SOL"] }))
      .toContain("relative_target_without_deployed_capital");
  });

  it("does NOT fire W1 once a valid declaration exists", () => {
    expect(codes({ successCriteria: ["Gain 50%"], deployedCapital: DECLARED })).toEqual([]);
  });

  // ── W2: absolute portfolio target ───────────────────────────────
  it("fires W2 for a numeric+symbol portfolio target, not only a dollar sign", () => {
    expect(codes({ successCriteria: ["Total balance reaches 15 USDC"] }))
      .toContain("absolute_portfolio_target_without_deployed_capital");
  });

  it("does NOT fire W2 without the portfolio scope", () => {
    // An absolute amount of a NAMED position is exactly the restatement the
    // warning asks for, so it must not warn about it.
    expect(codes({ successCriteria: ["Accumulated 10 SOL"], deployedCapital: DECLARED })).toEqual([]);
  });

  it("does NOT fire W2 on a non-money portfolio count", () => {
    expect(codes({ successCriteria: ["Portfolio holds 4 tokens"], deployedCapital: DECLARED })).toEqual([]);
  });

  // ── W3: an undecidable criterion ────────────────────────────────
  it("fires W3, once per offending index, for a criterion with no number", () => {
    const warnings = assessMissionMeasurability({
      successCriteria: ["Sold the position", "Accumulated 10 SOL", "Felt good about it"],
    });
    expect(warnings.map((w) => w.code)).toEqual([
      "success_criterion_has_no_number",
      "success_criterion_has_no_number",
    ]);
    expect(warnings[0].message).toContain("Success criterion 1 ");
    expect(warnings[1].message).toContain("Success criterion 3 ");
  });

  // ── No false positives ──────────────────────────────────────────
  it("stays silent on a concrete, decidable criterion", () => {
    expect(codes({ goal: "Accumulate SOL", successCriteria: ["Accumulated 10 SOL"] })).toEqual([]);
  });

  it("stays silent on an empty draft", () => {
    expect(codes({})).toEqual([]);
  });

  it("never throws on a partial draft", () => {
    expect(() => assessMissionMeasurability({ successCriteria: undefined, goal: null })).not.toThrow();
  });
});
