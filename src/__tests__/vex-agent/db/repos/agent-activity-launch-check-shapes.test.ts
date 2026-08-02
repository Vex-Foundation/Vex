/**
 * Migration 062 shape tests — does the widened vocabulary AS WRITTEN accept the
 * row shapes a Trench launch actually produces, and reject the mislabelling it
 * exists to prevent?
 *
 * Postgres is not available in this suite, so the constraint bodies are
 * extracted from the migration SOURCE and evaluated by `./_sql-check-eval.js`
 * (same approach as `agent-activity-yield-check-shapes.test.ts`). That is
 * strictly stronger than string-matching: an arm that accidentally lets a
 * `swap` row carry `token_launch` is a text a regex is happy with and this test
 * is not.
 *
 * The evaluator reads the LAST definition of each constraint across the
 * migrations it is given, which is why the whole migration set is concatenated
 * in file order — 062 DROPs and re-ADDs all three CHECKs whole, so its versions
 * are the live ones.
 *
 * ALSO pins the DELIBERATE ABSENCE of a launch confirmed-legs CHECK. Migration
 * 061 dropped the three that existed because status-only repair makes
 * `confirmed` + NULL `executed_*` a legitimate reachable state; adding one back
 * for `launch` would forbid exactly the rows the sweep must write. That absence
 * is a decision, and a decision worth a failing test if someone reverses it
 * without reading 061.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";
import { evaluateSqlCheck, extractCheckBody, type SqlRow } from "./_sql-check-eval.js";

const MIGRATIONS_DIR = join(getPackageRoot(), "src", "vex-agent", "db", "migrations");

const ALL_MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf-8"))
  .join("\n");

const MIGRATION_062 = readFileSync(join(MIGRATIONS_DIR, "062_trench_launch.sql"), "utf-8");

const KIND_VALID = extractCheckBody(ALL_MIGRATION_SQL, "agent_activity_kind_valid");
const ROLE_VALID = extractCheckBody(ALL_MIGRATION_SQL, "agent_activity_event_role_valid");
const KIND_ROLE_BINDING = extractCheckBody(ALL_MIGRATION_SQL, "agent_activity_kind_role_binding");
const SECOND_LEG_ROLES = extractCheckBody(ALL_MIGRATION_SQL, "agent_activity_second_leg_roles_only");

function bindingRow(kind: string, eventRole: string): SqlRow {
  return { kind, event_role: eventRole };
}

describe("migration 062 — the launch vocabulary", () => {
  it("admits `launch` as a kind without evicting any existing kind", () => {
    for (const kind of ["swap", "bridge", "lend", "prediction", "wrap", "yield", "launch"]) {
      expect(evaluateSqlCheck(KIND_VALID, { kind }), kind).toBe(true);
    }
  });

  it("still rejects a kind nobody defined", () => {
    expect(evaluateSqlCheck(KIND_VALID, { kind: "token_launch" })).toBe(false);
    expect(evaluateSqlCheck(KIND_VALID, { kind: "launchpad" })).toBe(false);
  });

  it("admits `token_launch` as a role without evicting any existing role", () => {
    for (const event_role of [
      "swap", "allowance", "allowance_reset", "bridge_deposit", "bridge_fee",
      "bridge_fill_expected", "bridge_fill_observed", "bridge_refund",
      "lend_deposit", "lend_withdraw", "lend_borrow_operate",
      "predict_buy", "predict_sell", "predict_claim", "predict_close",
      "wrap", "unwrap",
      "yield_pt", "yield_yt", "yield_py", "yield_lp", "yield_sy", "yield_claim",
      "token_launch",
    ]) {
      expect(evaluateSqlCheck(ROLE_VALID, { event_role }), event_role).toBe(true);
    }
  });

  it("does NOT fork a Trench-specific allowance role", () => {
    for (const invented of ["trench_allowance", "launch_allowance", "launch_prebuy"]) {
      expect(evaluateSqlCheck(ROLE_VALID, { event_role: invented }), invented).toBe(false);
    }
  });
});

describe("migration 062 — the kind↔role binding is what forbids mislabelling", () => {
  it("accepts the shape a launch actually writes", () => {
    expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow("launch", "token_launch"))).toBe(true);
  });

  it("REJECTS a launch recorded as a swap — the whole point of the binding", () => {
    // If this ever passes, a token creation can be written into the feed
    // asserting a route, a price and a counterparty it never had.
    expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow("swap", "token_launch"))).toBe(false);
    expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow("launch", "swap"))).toBe(false);
  });

  it("REJECTS `token_launch` on every other kind", () => {
    for (const kind of ["bridge", "lend", "prediction", "wrap", "yield"]) {
      expect(
        evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow(kind, "token_launch")),
        kind,
      ).toBe(false);
    }
  });

  it("REJECTS a launch carrying another kind's role", () => {
    for (const role of ["bridge_deposit", "lend_deposit", "predict_buy", "wrap", "yield_pt"]) {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow("launch", role)), role).toBe(false);
    }
  });

  it("leaves every pre-existing kind/role pairing exactly as it was", () => {
    const preserved: readonly [string, string][] = [
      ["swap", "swap"], ["swap", "allowance"],
      ["bridge", "bridge_fill_expected"], ["bridge", "bridge_fee"],
      ["lend", "lend_deposit"], ["prediction", "predict_buy"],
      ["wrap", "unwrap"], ["yield", "yield_claim"], ["yield", "allowance"],
    ];
    for (const [kind, role] of preserved) {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow(kind, role)), `${kind}/${role}`).toBe(true);
    }
  });
});

describe("migration 062 — a launch is barred from the Option-C second-leg family", () => {
  it("a token_launch row may not populate the second-leg columns", () => {
    const withSecondLeg: SqlRow = {
      event_role: "token_launch",
      token_in2_address: "0xin2",
      token_in2_symbol: null, token_in2_decimals: null,
      amount_in2_human: null, amount_in2_raw: null,
      executed_amount_in2_human: null, executed_amount_in2_raw: null,
      token_out2_address: null, token_out2_symbol: null, token_out2_decimals: null,
      amount_out2_human: null, amount_out2_raw: null,
      executed_amount_out2_human: null, executed_amount_out2_raw: null,
    };
    // Correct, and not an oversight: a create-with-prebuy is one-in (native)
    // one-out (the new token), so it never needs a second leg.
    expect(evaluateSqlCheck(SECOND_LEG_ROLES, withSecondLeg)).toBe(false);
  });
});

describe("migration 062 — the confirmed-legs CHECK is deliberately ABSENT", () => {
  it("adds no launch confirmed-legs constraint (061 dropped the others for a reason)", () => {
    // Asserted on ADDED CONSTRAINTS, not on the file text: the migration's
    // header NAMES the constraint it is refusing to create, and that prose is
    // the explanation a future reader needs, not a violation.
    const added = [...MIGRATION_062.matchAll(/ADD\s+CONSTRAINT\s+(\w+)/gi)].map((m) => m[1]!);
    expect(added.filter((name) => /confirmed.*legs/i.test(name))).toEqual([]);
    expect(added).not.toContain("agent_activity_launch_confirmed_legs");
  });

  it("re-adds none of the three constraints migration 061 dropped", () => {
    for (const dropped of [
      "agent_activity_confirmed_swap_has_executed_legs",
      "agent_activity_confirmed_wrap_has_executed_legs",
      "agent_activity_yield_confirmed_legs",
    ]) {
      expect(MIGRATION_062, dropped).not.toMatch(
        new RegExp(`ADD\\s+CONSTRAINT\\s+${dropped}`),
      );
    }
  });

  it("takes migration number 062 — 060 would be permanently version-skipped", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"));
    expect(files.filter((n) => n.startsWith("062_"))).toHaveLength(1);
    // 060 is not merely unused — re-using it would be silently skipped on every
    // database that already ran 061. Nothing may ever claim it.
    expect(files.filter((n) => n.startsWith("060_"))).toHaveLength(0);
  });
});
