/**
 * Migration 053 shape tests — does the CHECK text AS WRITTEN accept the row
 * shapes Pendle actually produces, and reject the ones that would falsify the
 * feed?
 *
 * Postgres is not available in this suite (the repo has no pgTAP or live-DB
 * migration test), so the constraint bodies are extracted from the migration
 * SOURCE and evaluated by `./_sql-check-eval.js`. That is strictly stronger
 * than the string-matching a migration test would otherwise do: a per-role arm
 * that accidentally accepts a `yield_claim` with no output credit is a text a
 * regex is happy with and this test is not.
 *
 * Not a substitute for applying the migration — it proves the PREDICATE's
 * behaviour, not that Postgres parses the file. `pnpm test` plus a real
 * `migrate` run cover the latter.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";
import { evaluateSqlCheck, extractCheckBody, type SqlRow } from "./_sql-check-eval.js";

const MIGRATION_SQL = readFileSync(
  join(
    getPackageRoot(),
    "src",
    "vex-agent",
    "db",
    "migrations",
    "053_agent_activity_yield_vocabulary.sql",
  ),
  "utf-8",
);

const CONFIRMED_LEGS = extractCheckBody(MIGRATION_SQL, "agent_activity_yield_confirmed_legs");
const SECOND_LEG_ROLES = extractCheckBody(MIGRATION_SQL, "agent_activity_second_leg_roles_only");
const PY_ONE_SECOND_LEG = extractCheckBody(
  MIGRATION_SQL,
  "agent_activity_yield_py_has_one_second_leg",
);
const KIND_ROLE_BINDING = extractCheckBody(MIGRATION_SQL, "agent_activity_kind_role_binding");
const SECOND_LEG_IN_AMOUNT = extractCheckBody(
  MIGRATION_SQL,
  "agent_activity_second_leg_amount_has_token",
);
const SECOND_LEG_OUT_AMOUNT = extractCheckBody(
  MIGRATION_SQL,
  "agent_activity_second_leg_out_amount_has_token",
);

/**
 * Every column the three predicates read, NULL by default. Deliberately NOT
 * annotated `SqlRow`: the literal keys are what lets `row()` reject a typo'd
 * column name.
 */
const EMPTY_ROW = {
  status: "confirmed",
  tx_hash: null,
  kind: "yield",
  event_role: "yield_pt",
  executed_amount_in_raw: null,
  executed_amount_out_raw: null,
  token_in2_address: null,
  token_in2_symbol: null,
  token_in2_decimals: null,
  amount_in2_human: null,
  amount_in2_raw: null,
  executed_amount_in2_human: null,
  executed_amount_in2_raw: null,
  token_out2_address: null,
  token_out2_symbol: null,
  token_out2_decimals: null,
  amount_out2_human: null,
  amount_out2_raw: null,
  executed_amount_out2_human: null,
  executed_amount_out2_raw: null,
};

function row(overrides: Partial<Record<keyof typeof EMPTY_ROW, string | null>>): SqlRow {
  const merged: Record<string, string | null> = { ...EMPTY_ROW };
  for (const [column, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[column] = value;
  }
  return merged;
}

describe("053 — agent_activity_yield_confirmed_legs, per role", () => {
  it("accepts a confirmed yield_pt / yield_yt with one executed leg on each side", () => {
    for (const eventRole of ["yield_pt", "yield_yt"]) {
      const shape = row({
        event_role: eventRole,
        executed_amount_in_raw: "1000000",
        executed_amount_out_raw: "990000",
      });
      expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(true);
    }
  });

  it("rejects a confirmed yield_pt missing an executed leg", () => {
    expect(
      evaluateSqlCheck(CONFIRMED_LEGS, row({ executed_amount_in_raw: "1000000" })),
    ).toBe(false);
    expect(
      evaluateSqlCheck(CONFIRMED_LEGS, row({ executed_amount_out_raw: "990000" })),
    ).toBe(false);
  });

  it("accepts a confirmed yield_sy with one executed leg on each side", () => {
    // SY mint/redeem is a WRAP, not a split: one token in, one SY out (or the
    // reverse). It gets `yield_pt`'s ordinary shape, never a second leg.
    const shape = row({
      event_role: "yield_sy",
      executed_amount_in_raw: "1000000",
      executed_amount_out_raw: "999000",
    });
    expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(true);
  });

  it("rejects a confirmed yield_sy missing either executed leg", () => {
    expect(
      evaluateSqlCheck(
        CONFIRMED_LEGS,
        row({ event_role: "yield_sy", executed_amount_in_raw: "1000000" }),
      ),
    ).toBe(false);
    expect(
      evaluateSqlCheck(
        CONFIRMED_LEGS,
        row({ event_role: "yield_sy", executed_amount_out_raw: "999000" }),
      ),
    ).toBe(false);
    expect(evaluateSqlCheck(CONFIRMED_LEGS, row({ event_role: "yield_sy" }))).toBe(false);
  });

  it("leaves a PENDING row alone whatever its legs — ambiguity never terminalizes", () => {
    expect(evaluateSqlCheck(CONFIRMED_LEGS, row({ status: "pending" }))).toBe(true);
    expect(
      evaluateSqlCheck(CONFIRMED_LEGS, row({ status: "pending", event_role: "yield_claim" })),
    ).toBe(true);
  });

  it("accepts a confirmed yield_claim with an OUTPUT credit only", () => {
    const shape = row({ event_role: "yield_claim", executed_amount_out_raw: "4210" });
    expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(true);
  });

  it("rejects a confirmed yield_claim with no output credit", () => {
    expect(evaluateSqlCheck(CONFIRMED_LEGS, row({ event_role: "yield_claim" }))).toBe(false);
  });

  it("rejects a confirmed yield_claim that invents an INPUT leg — a claim spends nothing", () => {
    const shape = row({
      event_role: "yield_claim",
      executed_amount_out_raw: "4210",
      executed_amount_in_raw: "1",
    });
    expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(false);
  });

  it("accepts a confirmed yield_py MINT proving both executed OUT legs", () => {
    const shape = row({
      event_role: "yield_py",
      executed_amount_in_raw: "1000000",
      executed_amount_out_raw: "990000",
      token_out2_address: "0xyt",
      executed_amount_out2_raw: "990000",
    });
    expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(true);
  });

  it("rejects a confirmed yield_py MINT that names a second OUT token but proves only one leg", () => {
    const shape = row({
      event_role: "yield_py",
      executed_amount_in_raw: "1000000",
      executed_amount_out_raw: "990000",
      token_out2_address: "0xyt",
    });
    expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(false);
  });

  it("accepts a confirmed yield_py REDEEM proving both executed IN legs", () => {
    const shape = row({
      event_role: "yield_py",
      executed_amount_in_raw: "990000",
      token_in2_address: "0xyt",
      executed_amount_in2_raw: "990000",
      executed_amount_out_raw: "1000000",
    });
    expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(true);
  });

  it("rejects a confirmed yield_py REDEEM missing the second executed IN leg", () => {
    const shape = row({
      event_role: "yield_py",
      executed_amount_in_raw: "990000",
      token_in2_address: "0xyt",
      executed_amount_out_raw: "1000000",
    });
    expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(false);
  });

  it("accepts a confirmed SINGLE-token yield_lp — dual invariants apply only where dual is populated", () => {
    const shape = row({
      event_role: "yield_lp",
      executed_amount_in_raw: "1000000",
      executed_amount_out_raw: "31337",
    });
    expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(true);
  });

  it("rejects a confirmed DUAL yield_lp that names a second token without proving it", () => {
    const shape = row({
      event_role: "yield_lp",
      executed_amount_in_raw: "31337",
      executed_amount_out_raw: "1000000",
      token_out2_address: "0xyt",
    });
    expect(evaluateSqlCheck(CONFIRMED_LEGS, shape)).toBe(false);
  });

  it("does not constrain non-yield roles", () => {
    for (const eventRole of ["swap", "allowance", "wrap", "lend_deposit"]) {
      expect(evaluateSqlCheck(CONFIRMED_LEGS, row({ event_role: eventRole }))).toBe(true);
    }
  });
});

describe("053 — second-leg columns are bound to yield_py / yield_lp", () => {
  it("accepts a populated second leg on yield_py and yield_lp", () => {
    for (const eventRole of ["yield_py", "yield_lp"]) {
      const shape = row({ event_role: eventRole, token_out2_address: "0xyt" });
      expect(evaluateSqlCheck(SECOND_LEG_ROLES, shape)).toBe(true);
    }
  });

  it("rejects a populated second leg on yield_pt / yield_yt / yield_sy / yield_claim / swap", () => {
    for (const eventRole of ["yield_pt", "yield_yt", "yield_sy", "yield_claim", "swap"]) {
      const shape = row({ event_role: eventRole, token_out2_address: "0xyt" });
      expect(evaluateSqlCheck(SECOND_LEG_ROLES, shape)).toBe(false);
    }
  });

  it("rejects an ORPHAN second-leg amount on a non-dual role even with no token", () => {
    const shape = row({ event_role: "yield_pt", executed_amount_out2_raw: "990000" });
    expect(evaluateSqlCheck(SECOND_LEG_ROLES, shape)).toBe(false);
  });

  it("accepts an all-NULL second leg on every role", () => {
    for (const eventRole of ["yield_pt", "yield_claim", "swap", "bridge_deposit"]) {
      expect(evaluateSqlCheck(SECOND_LEG_ROLES, row({ event_role: eventRole }))).toBe(true);
    }
  });
});

describe("053 — a yield_py row populates EXACTLY one second-leg side", () => {
  it("accepts a mint (second OUT) and a redeem (second IN)", () => {
    expect(
      evaluateSqlCheck(PY_ONE_SECOND_LEG, row({ event_role: "yield_py", token_out2_address: "0xyt" })),
    ).toBe(true);
    expect(
      evaluateSqlCheck(PY_ONE_SECOND_LEG, row({ event_role: "yield_py", token_in2_address: "0xyt" })),
    ).toBe(true);
  });

  it("rejects a yield_py with neither second-leg side — that is a yield_pt/yield_yt", () => {
    expect(evaluateSqlCheck(PY_ONE_SECOND_LEG, row({ event_role: "yield_py" }))).toBe(false);
  });

  it("rejects a yield_py with BOTH second-leg sides — no Pendle action has that shape", () => {
    const shape = row({
      event_role: "yield_py",
      token_in2_address: "0xpt",
      token_out2_address: "0xyt",
    });
    expect(evaluateSqlCheck(PY_ONE_SECOND_LEG, shape)).toBe(false);
  });

  it("EXEMPTS a hashless definitively_failed PY refusal that never learned its second leg", () => {
    // The commonest PY refusal is an unresolved market — the YT address is
    // exactly what the resolution failed to produce. Without this arm the
    // refusal is unwritable and a funds-untouched refusal vanishes.
    const shape = row({
      event_role: "yield_py",
      status: "definitively_failed",
      tx_hash: null,
    });
    expect(evaluateSqlCheck(PY_ONE_SECOND_LEG, shape)).toBe(true);
  });

  it("accepts a definitively_failed PY refusal that DID resolve its second leg", () => {
    const shape = row({
      event_role: "yield_py",
      status: "definitively_failed",
      tx_hash: null,
      token_out2_address: "0xyt",
    });
    expect(evaluateSqlCheck(PY_ONE_SECOND_LEG, shape)).toBe(true);
  });

  it("does NOT exempt a definitively_failed row that was BROADCAST — it knew both legs when staged", () => {
    const shape = row({ event_role: "yield_py", status: "definitively_failed", tx_hash: "0xabc" });
    expect(evaluateSqlCheck(PY_ONE_SECOND_LEG, shape)).toBe(false);
  });

  it("does NOT exempt a pending or confirmed hashless row", () => {
    for (const status of ["pending", "confirmed"]) {
      expect(evaluateSqlCheck(PY_ONE_SECOND_LEG, row({ event_role: "yield_py", status }))).toBe(
        false,
      );
    }
  });
});

describe("053 — a second-leg raw amount travels with its decimals", () => {
  it.each([
    ["amount_in2_raw", SECOND_LEG_IN_AMOUNT, "token_in2_address", "token_in2_decimals"],
    ["executed_amount_in2_raw", SECOND_LEG_IN_AMOUNT, "token_in2_address", "token_in2_decimals"],
    ["amount_out2_raw", SECOND_LEG_OUT_AMOUNT, "token_out2_address", "token_out2_decimals"],
    [
      "executed_amount_out2_raw",
      SECOND_LEG_OUT_AMOUNT,
      "token_out2_address",
      "token_out2_decimals",
    ],
  ])("rejects %s populated with NULL decimals — 1047061 is 1.05 or 0.00105", (
    amountColumn,
    check,
    addressColumn,
    decimalsColumn,
  ) => {
    const shape: SqlRow = {
      ...EMPTY_ROW,
      event_role: "yield_py",
      [addressColumn]: "0xyt",
      [decimalsColumn]: null,
      [amountColumn]: "1047061",
    };
    expect(evaluateSqlCheck(check, shape)).toBe(false);
  });

  it("accepts a populated second-leg amount that states both its token and its decimals", () => {
    expect(
      evaluateSqlCheck(
        SECOND_LEG_IN_AMOUNT,
        row({ amount_in2_raw: "1047061", token_in2_address: "0xyt", token_in2_decimals: "18" }),
      ),
    ).toBe(true);
    expect(
      evaluateSqlCheck(
        SECOND_LEG_OUT_AMOUNT,
        row({ amount_out2_raw: "1047061", token_out2_address: "0xyt", token_out2_decimals: "18" }),
      ),
    ).toBe(true);
  });

  it("treats ZERO decimals as a real answer, not as absent", () => {
    expect(
      evaluateSqlCheck(
        SECOND_LEG_OUT_AMOUNT,
        row({ amount_out2_raw: "7", token_out2_address: "0xyt", token_out2_decimals: "0" }),
      ),
    ).toBe(true);
  });

  it("leaves an amount-less second leg alone — naming a token is not a claim about size", () => {
    expect(
      evaluateSqlCheck(SECOND_LEG_OUT_AMOUNT, row({ token_out2_address: "0xyt" })),
    ).toBe(true);
    expect(evaluateSqlCheck(SECOND_LEG_IN_AMOUNT, row({}))).toBe(true);
  });
});

describe("053 — the yield arm of the kind<->role binding", () => {
  it("accepts every yield role, plus the REUSED allowance roles, under kind='yield'", () => {
    for (const eventRole of [
      "yield_pt",
      "yield_yt",
      "yield_py",
      "yield_lp",
      "yield_sy",
      "yield_claim",
      "allowance",
      "allowance_reset",
    ]) {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, row({ kind: "yield", event_role: eventRole }))).toBe(
        true,
      );
    }
  });

  it("rejects a yield role under any other kind, and a foreign role under kind='yield'", () => {
    for (const kind of ["swap", "bridge", "lend", "prediction", "wrap"]) {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, row({ kind, event_role: "yield_pt" }))).toBe(false);
    }
    for (const eventRole of ["swap", "wrap", "lend_deposit", "predict_buy"]) {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, row({ kind: "yield", event_role: eventRole }))).toBe(
        false,
      );
    }
  });
});
