/**
 * Lockstep guard, sibling of `agent-activity-failure-code-lockstep.test.ts`:
 * the SQL `agent_activity_kind_valid` / `agent_activity_event_role_valid`
 * CHECKs and the TypeScript `AgentActivityKind` / `AgentActivityEventRole`
 * unions (`db/repos/agent-activity/types.ts`) MUST list the exact same
 * vocabulary.
 *
 * WHY. Migration 051 added `wrap`/`unwrap` to SQL and the TS unions were never
 * updated — the drift survived a full green suite because a TYPE cannot be
 * asserted at runtime. The consequence is one-directional and quiet: a writer
 * cannot name the new kind in TS at all, and a reader's `mapRow` casts the DB
 * string into a union that does not contain it. This test makes that drift a
 * failing test instead of a discovery.
 *
 * Both sides are parsed from SOURCE — every migration file (the LAST definition
 * of each constraint in migration order is the live one) and `types.ts` itself.
 * Parsing the TS union text is the only way to compare a compile-time union
 * against runtime data; there is deliberately no runtime kind/role array in the
 * engine to compare against instead.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";

const MIGRATIONS_DIR = join(getPackageRoot(), "src", "vex-agent", "db", "migrations");

/** Every migration, in filename (= application) order, concatenated. */
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf-8"))
  .join("\n");

const TYPES_TS = readFileSync(
  join(getPackageRoot(), "src", "vex-agent", "db", "repos", "agent-activity", "types.ts"),
  "utf-8",
);

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

/** Extract the string-literal members of an `export type X = "a" | "b";` union. */
function parseTsUnion(typeName: string): string[] {
  const re = new RegExp(`export type ${typeName} =([^;]*);`);
  const match = re.exec(TYPES_TS);
  if (!match) {
    throw new Error(`lockstep: TS union '${typeName}' not found in types.ts`);
  }
  const members = match[1]!.match(/"([^"]+)"/g);
  if (!members) {
    throw new Error(`lockstep: TS union '${typeName}' has no string members`);
  }
  return members.map((member) => member.slice(1, -1));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("agent_activity kind/role — SQL CHECK <-> TS union lockstep", () => {
  it("the SQL kind CHECK and AgentActivityKind list the exact same kinds", () => {
    expect(sorted(parseTsUnion("AgentActivityKind"))).toEqual(
      sorted(parseInListCheck("agent_activity_kind_valid", "kind")),
    );
  });

  it("the SQL role CHECK and AgentActivityEventRole list the exact same roles", () => {
    expect(sorted(parseTsUnion("AgentActivityEventRole"))).toEqual(
      sorted(parseInListCheck("agent_activity_event_role_valid", "event_role")),
    );
  });

  it("carries the migration-053 yield vocabulary on both sides", () => {
    const kinds = parseInListCheck("agent_activity_kind_valid", "kind");
    const roles = parseInListCheck("agent_activity_event_role_valid", "event_role");
    expect(kinds).toContain("yield");
    expect(parseTsUnion("AgentActivityKind")).toContain("yield");
    for (const role of ["yield_pt", "yield_yt", "yield_py", "yield_lp", "yield_claim"]) {
      expect(roles).toContain(role);
      expect(parseTsUnion("AgentActivityEventRole")).toContain(role);
    }
  });

  it("does NOT fork Pendle-specific allowance roles — `allowance`/`allowance_reset` are reused", () => {
    const roles = parseInListCheck("agent_activity_event_role_valid", "event_role");
    expect(roles).toContain("allowance");
    expect(roles).toContain("allowance_reset");
    for (const invented of ["pendle_allowance", "yield_allowance", "yield_approve"]) {
      expect(roles).not.toContain(invented);
      expect(parseTsUnion("AgentActivityEventRole")).not.toContain(invented);
    }
  });
});
