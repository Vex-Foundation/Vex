/**
 * Shared lockstep helpers for the memory-schema enum drift guards.
 *
 * Each bounded-vocab enum lives in TWO places that MUST stay identical: a named
 * CHECK constraint somewhere under `db/migrations/` (the DB enforces it at
 * write time) and an `as const` tuple + `z.enum(...)` in a `memory/schema/*`
 * module (TS + import validation enforce it). These helpers parse the SQL CHECK
 * value lists so the per-enum tests can assert SQL == TS == Zod options.
 *
 * Extracted (S1c) from `memory-candidate-enums.test.ts` so the candidate,
 * job, and decision enum tests share ONE parser (rules/10 §17: 3+ uses → extract).
 *
 * The migrations are read from the human-edited SOURCE files (not a build
 * artifact) so a stale `dist/` can never mask a drift in the source.
 *
 * `001_initial.sql` created every job/candidate/decision CHECK originally and
 * is never hand-edited afterward (expand-and-contract discipline — applied
 * migrations are append-only). `044_agent_activity.sql` is the first later
 * migration to WIDEN one of these named CHECKs in place (`mj_status_valid`
 * gains `retired`, same drop+re-add pattern as
 * `034_swap_prequotes_redeem_kind.sql`). `MIGRATION_SQL` therefore concatenates
 * 001 then 044 (in migration order) so `parseCheckInList` can find whichever
 * definition is CURRENT; every other enum this module backs is untouched by
 * 044, so only the widened constraint's lookup is affected.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getPackageRoot } from "@utils/package-assets.js";

function readMigration(filename: string): string {
  return readFileSync(
    join(getPackageRoot(), "src", "vex-agent", "db", "migrations", filename),
    "utf-8",
  );
}

/** Concatenated text of every migration that (re)defines a tracked CHECK, in apply order. */
export const MIGRATION_SQL: string = [
  readMigration("001_initial.sql"),
  readMigration("044_agent_activity.sql"),
].join("\n");

/**
 * Extract the quoted value list from the LAST named CHECK of the form
 * `CONSTRAINT <name> CHECK (<column> IN ('a','b',...))` in `sql` — later
 * migrations that DROP + re-ADD a constraint under the same name take
 * precedence over the original `001_initial.sql` definition. Throws if the
 * constraint is absent so a rename/removal fails loudly rather than silently
 * passing against an empty set.
 */
export function parseCheckInList(sql: string, constraintName: string, column: string): string[] {
  const re = new RegExp(
    `CONSTRAINT\\s+${constraintName}\\s+CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
    "gi",
  );
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(sql)) !== null) {
    last = match;
  }
  if (!last) {
    throw new Error(
      `lockstep: named CHECK '${constraintName}' on column '${column}' not found in 001_initial.sql`,
    );
  }
  return last[1]!
    .split(",")
    .map((token) => token.trim().replace(/^'(.*)'$/, "$1"))
    .filter((token) => token.length > 0);
}

/** Order-independent set comparison via sorted copies. */
export function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}
