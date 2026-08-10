/**
 * Lockstep guard, sibling of `db/repos/agent-activity-kind-role-lockstep.test.ts`:
 * the AgentScan reporting predicate (`REPORTED_KINDS` / `REPORTED_ROLES` /
 * `REPORTED_STATUSES` in `db/repos/agentscan-reporting.ts`) MUST cover the exact
 * vocabulary the `agent_activity` CHECKs admit.
 *
 * WHY. The predicate used to be a hand-written SQL list naming two kinds and
 * five roles while the engine recorded seven and twenty-six. That is not a
 * decision anyone took — it is a list nobody widened, and the cost is silent:
 * an activity kind simply never reaches the explorer, and no test goes red
 * because a SQL string literal cannot notice what was never added to it.
 *
 * This test makes the omission a FAILING TEST instead of a discovery. Adding a
 * kind or role to the vocabulary now forces a reporting decision: either add it
 * to the reported list, or exclude it DELIBERATELY — by naming it, with its
 * reason, in an exclusion set here and in the predicate's own docblock. An
 * exclusion is a line of code someone wrote; an omission is not.
 *
 * The membership half of the guard is not here: `satisfies readonly
 * AgentActivityKind[]` already makes a reported value outside the union a
 * compile error. This test owns COMPLETENESS, which a type cannot assert.
 *
 * The SQL side is parsed from SOURCE — every migration file, the LAST
 * definition of each constraint in migration order being the live one —
 * exactly as the sibling lockstep does.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";

import {
  REPORTED_KINDS,
  REPORTED_ROLES,
  REPORTED_STATUSES,
} from "@vex-agent/db/repos/agentscan-reporting.js";

const MIGRATIONS_DIR = join(getPackageRoot(), "src", "vex-agent", "db", "migrations");

/** Every migration, in filename (= application) order, concatenated. */
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf-8"))
  .join("\n");

/** Extract the LAST `CONSTRAINT <name> CHECK (<column> IN (...))` value list. */
function parseInListCheck(constraintName: string, column: string): string[] {
  const re = new RegExp(
    `CONSTRAINT\\s+${constraintName}\\s+CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
    "gi",
  );
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(MIGRATION_SQL)) !== null) {
    last = match;
  }
  if (!last) {
    throw new Error(`lockstep: '${constraintName}' CHECK not found in the migrations`);
  }
  return last[1]!
    .split(",")
    .map((token) => token.trim().replace(/^'(.*)'$/, "$1"))
    .filter((token) => token.length > 0);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/**
 * Kinds and roles deliberately NOT reported, each with the reason it is held
 * back. Adding an entry here is how an exclusion is DECLARED — never by leaving
 * a value out of the reported list, which this test would fail.
 *
 * `allowance` / `allowance_reset`: an approval would be counted by AgentScan's
 * `daily_aggregates.tx_count`, which is written incrementally and never
 * recomputed from raw events, so the published count would permanently mean
 * "operations plus an unpredictable number of approvals". Excluding is
 * reversible, including is not — and an approval moves no value, so there is no
 * explorer value on the other side of that trade. The reasoning in full lives
 * with the predicate, in `db/repos/agentscan-reporting.ts`.
 */
const DELIBERATELY_UNREPORTED_KINDS: readonly string[] = [];
const DELIBERATELY_UNREPORTED_ROLES: readonly string[] = ["allowance", "allowance_reset"];

function without(values: readonly string[], excluded: readonly string[]): string[] {
  return values.filter((value) => !excluded.includes(value));
}

describe("AgentScan reporting predicate — vocabulary lockstep", () => {
  it("reports every activity kind the SQL CHECK admits", () => {
    expect(sorted(REPORTED_KINDS)).toEqual(
      sorted(without(parseInListCheck("agent_activity_kind_valid", "kind"), DELIBERATELY_UNREPORTED_KINDS)),
    );
  });

  it("reports every event role the SQL CHECK admits", () => {
    expect(sorted(REPORTED_ROLES)).toEqual(
      sorted(without(parseInListCheck("agent_activity_event_role_valid", "event_role"), DELIBERATELY_UNREPORTED_ROLES)),
    );
  });

  it("reports every activity status the SQL CHECK admits, including superseded_unproven", () => {
    expect(sorted(REPORTED_STATUSES)).toEqual(
      sorted(parseInListCheck("agent_activity_status_check", "status")),
    );
    expect(REPORTED_STATUSES).toContain("superseded_unproven");
  });

  it("covers the whole seven-kind vocabulary the engine records", () => {
    expect(sorted(REPORTED_KINDS)).toEqual(
      ["bridge", "launch", "lend", "prediction", "swap", "wrap", "yield"],
    );
  });

  it("carries the kinds that used to be silently dropped", () => {
    for (const kind of ["lend", "prediction", "wrap", "yield", "launch"]) {
      expect(REPORTED_KINDS).toContain(kind);
    }
  });

  it("carries the roles that used to be silently dropped", () => {
    for (const role of [
      "bridge_fee", "swap_fee", "trench_fee",
      "lend_deposit", "lend_withdraw", "lend_borrow_operate",
      "predict_buy", "predict_sell", "predict_claim", "predict_close",
      "wrap", "unwrap",
      "yield_pt", "yield_yt", "yield_py", "yield_lp", "yield_sy", "yield_claim",
      "token_launch",
    ]) {
      expect(REPORTED_ROLES).toContain(role);
    }
  });

  it("holds back the two approval roles, leaving twenty-four reported", () => {
    expect(sorted(DELIBERATELY_UNREPORTED_ROLES)).toEqual(["allowance", "allowance_reset"]);
    expect(REPORTED_ROLES).not.toContain("allowance");
    expect(REPORTED_ROLES).not.toContain("allowance_reset");
    expect(REPORTED_ROLES).toHaveLength(24);
  });
});

describe("AgentScan outbox status CHECK — holds what the scan can enqueue", () => {
  it("admits exactly the statuses the predicate reports (migration 076)", () => {
    expect(sorted(parseInListCheck("agentscan_outbox_status_check", "status"))).toEqual(
      sorted(REPORTED_STATUSES),
    );
  });
});
