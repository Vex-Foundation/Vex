/**
 * `roleLegsIncomplete` — the ONE predicate for "does this row's role still owe
 * an executed leg?", pinned per ROLE rather than on representative cases.
 *
 * Three callers ask it from different sides (the strict confirm guard, the
 * late-fill CAS, the settlement-decline writer) and a fourth now mirrors it in
 * SQL (the AgentScan readiness gate). A role whose rule is wrong here is a row
 * that either reports money it never proved, or waits forever for money that is
 * already complete — so every amount-bearing role is enumerated, and so is the
 * fact that the rest bear no amounts at all.
 *
 * `bridge_deposit` is the role this suite exists to pin hardest: it is
 * INPUT-ONLY. Its output lands on the destination chain, in another
 * transaction, on the fill row, so a rule that demanded both legs would hold
 * every healthy deposit incomplete forever.
 */
import { describe, it, expect } from "vitest";

import { roleLegsIncomplete, isAmountBearingRole } from "../../../../vex-agent/db/repos/agent-activity/role-legs.js";
import type { RoleLegRow } from "../../../../vex-agent/db/repos/agent-activity/role-legs.js";
import type { AgentActivityEventRole } from "../../../../vex-agent/db/repos/agent-activity/types.js";

const EMPTY: Omit<RoleLegRow, "eventRole"> = {
  executedAmountInRaw: null,
  executedAmountOutRaw: null,
  executedAmountIn2Raw: null,
  executedAmountOut2Raw: null,
  tokenIn2Address: null,
  tokenOut2Address: null,
};

function row(eventRole: AgentActivityEventRole, fields: Partial<RoleLegRow> = {}): RoleLegRow {
  return { ...EMPTY, eventRole, ...fields };
}

/** Every role that requires BOTH executed legs and nothing else. */
const BOTH_LEG_ROLES: readonly AgentActivityEventRole[] = [
  "swap",
  "wrap",
  "unwrap",
  "token_launch",
  "yield_pt",
  "yield_yt",
  "yield_sy",
  "lend_deposit",
  "lend_withdraw",
  "lend_borrow_operate",
  "predict_buy",
  "predict_sell",
  "predict_claim",
  "predict_close",
];

/** Every role that bears no settlement amount at all — never "incomplete". */
const AMOUNTLESS_ROLES: readonly AgentActivityEventRole[] = [
  "allowance",
  "allowance_reset",
  "swap_fee",
  "trench_fee",
  "bridge_fee",
  "bridge_fill_expected",
  "bridge_fill_observed",
  "bridge_refund",
];

describe("roleLegsIncomplete — both-leg roles", () => {
  for (const role of BOTH_LEG_ROLES) {
    it(`${role} owes both legs`, () => {
      expect(roleLegsIncomplete(row(role))).toBe(true);
      expect(roleLegsIncomplete(row(role, { executedAmountInRaw: "1" }))).toBe(true);
      expect(roleLegsIncomplete(row(role, { executedAmountOutRaw: "1" }))).toBe(true);
      expect(
        roleLegsIncomplete(row(role, { executedAmountInRaw: "1", executedAmountOutRaw: "2" })),
      ).toBe(false);
    });
  }
});

describe("roleLegsIncomplete — the asymmetric roles", () => {
  it("bridge_deposit is INPUT-only: its output lands on the destination chain", () => {
    expect(isAmountBearingRole("bridge_deposit")).toBe(true);
    expect(roleLegsIncomplete(row("bridge_deposit"))).toBe(true);
    expect(roleLegsIncomplete(row("bridge_deposit", { executedAmountInRaw: "1000000" }))).toBe(false);
    // An output it will never have must not keep it incomplete.
    expect(roleLegsIncomplete(row("bridge_deposit", { executedAmountOutRaw: "1" }))).toBe(true);
  });

  it("yield_claim is OUTPUT-only: a claim spends nothing", () => {
    expect(roleLegsIncomplete(row("yield_claim"))).toBe(true);
    expect(roleLegsIncomplete(row("yield_claim", { executedAmountOutRaw: "1" }))).toBe(false);
    expect(roleLegsIncomplete(row("yield_claim", { executedAmountInRaw: "1" }))).toBe(true);
  });
});

describe("roleLegsIncomplete — the Option-C second legs", () => {
  for (const role of ["yield_py", "yield_lp"] as const) {
    it(`${role} requires a second leg only where the row populated its token`, () => {
      const bothFirst = { executedAmountInRaw: "1", executedAmountOutRaw: "2" };
      expect(roleLegsIncomplete(row(role, bothFirst))).toBe(false);

      expect(
        roleLegsIncomplete(row(role, { ...bothFirst, tokenOut2Address: "0xabc" })),
      ).toBe(true);
      expect(
        roleLegsIncomplete(
          row(role, { ...bothFirst, tokenOut2Address: "0xabc", executedAmountOut2Raw: "3" }),
        ),
      ).toBe(false);

      expect(
        roleLegsIncomplete(row(role, { ...bothFirst, tokenIn2Address: "0xabc" })),
      ).toBe(true);
      expect(
        roleLegsIncomplete(
          row(role, { ...bothFirst, tokenIn2Address: "0xabc", executedAmountIn2Raw: "3" }),
        ),
      ).toBe(false);
    });
  }
});

describe("roleLegsIncomplete — roles that bear no amounts", () => {
  for (const role of AMOUNTLESS_ROLES) {
    it(`${role} is never incomplete`, () => {
      expect(isAmountBearingRole(role)).toBe(false);
      expect(roleLegsIncomplete(row(role))).toBe(false);
    });
  }
});
