/**
 * Lockstep guard, sibling of `swap-prequotes-kind-lockstep.test.ts`: the SQL
 * CHECK vocabularies in `058_compaction_preparations.sql` and the TypeScript
 * unions in `db/repos/compaction-preparations/types.ts` must list the exact same
 * values.
 *
 * WHY. Every one of these vocabularies is a PREDICATE, not a label:
 *   - `status` decides who owns the row and whether a fork is even possible (the
 *     one-live-per-session partial unique names four of its values);
 *   - `summary_status` / `chunks_status` decide claimability;
 *   - `apply_source` decides whether the money gate is bypassed.
 *
 * Drift is quiet in both directions. TS ahead of SQL: a writer names a value
 * Postgres rejects, and because these writes happen inside background workers,
 * the throw surfaces as a mysterious retry loop rather than as the schema error
 * it is. SQL ahead of TS: `mapRow` meets a string its union does not contain —
 * and a TYPE cannot be asserted at runtime.
 *
 * The partial unique's own predicate is checked too, because the fork-time
 * insert repeats it verbatim as the ON CONFLICT arbiter; if the two ever
 * disagree Postgres cannot match the index and the insert fails outright.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";

import {
  APPLY_SOURCES,
  CHUNKS_BRANCH_STATUSES,
  LIVE_PREPARATION_STATUSES,
  PREPARATION_STATUSES,
  SUMMARY_BRANCH_STATUSES,
} from "@vex-agent/db/repos/compaction-preparations/index.js";

const MIGRATIONS_DIR = join(getPackageRoot(), "src", "vex-agent", "db", "migrations");

/**
 * Every migration in application order, comments stripped, scoped to
 * statements that mention `compaction_preparations`. The scope matters:
 * other tables also constrain columns named `status` (migration 062's
 * `token_launch_intents` was the first to land after 058 in file order), and
 * an unscoped last-CHECK-wins scan would read a different table's vocabulary.
 */
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf-8"))
  .join("\n")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .filter((statement) => statement.includes("compaction_preparations"))
  .join(";");

const CREATE_SQL = readFileSync(
  join(MIGRATIONS_DIR, "058_compaction_preparations.sql"),
  "utf-8",
);

/** Last `CHECK (<column> IN (...))` for a column — the live definition. */
function parseCheckVocabulary(column: string): string[] {
  const re = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "gi");
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(MIGRATION_SQL)) !== null) last = match;
  if (!last) throw new Error(`lockstep: no CHECK found for column "${column}"`);
  return [...last[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("058 status vocabularies match the TypeScript unions", () => {
  it("status", () => {
    expect(parseCheckVocabulary("status").sort()).toEqual([...PREPARATION_STATUSES].sort());
  });

  it("summary_status", () => {
    expect(parseCheckVocabulary("summary_status").sort()).toEqual(
      [...SUMMARY_BRANCH_STATUSES].sort(),
    );
  });

  it("chunks_status", () => {
    expect(parseCheckVocabulary("chunks_status").sort()).toEqual(
      [...CHUNKS_BRANCH_STATUSES].sort(),
    );
  });

  it("apply_source is exactly the four frozen values", () => {
    const re = /apply_source\s+IN\s*\(([^)]*)\)/i;
    const match = re.exec(MIGRATION_SQL);
    expect(match).not.toBeNull();
    const sqlSources = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(sqlSources.sort()).toEqual([...APPLY_SOURCES].sort());
    // `apply_requested` is a status; it must never appear as a source.
    expect(sqlSources).not.toContain("apply_requested");
  });

  it("chunks adds exactly `frozen` on top of the summary vocabulary", () => {
    const extra = CHUNKS_BRANCH_STATUSES.filter(
      (status) => !SUMMARY_BRANCH_STATUSES.some((s) => s === status),
    );
    expect(extra).toEqual(["frozen"]);
  });
});

describe("058 partial-unique predicate matches LIVE_PREPARATION_STATUSES", () => {
  it("the index predicate lists exactly the live statuses", () => {
    const re =
      /CREATE UNIQUE INDEX[^;]*uniq_cprep_live_per_session[^;]*WHERE status IN \(([^)]*)\)/i;
    const match = re.exec(CREATE_SQL);
    expect(match).not.toBeNull();
    const indexStatuses = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(indexStatuses.sort()).toEqual([...LIVE_PREPARATION_STATUSES].sort());
  });

  it("the fork-time ON CONFLICT arbiter repeats the same predicate", () => {
    const createTs = readFileSync(
      join(
        getPackageRoot(),
        "src",
        "vex-agent",
        "db",
        "repos",
        "compaction-preparations",
        "create.ts",
      ),
      "utf-8",
    );
    const re = /ON CONFLICT \(session_id\)\s*\n\s*WHERE status IN \(([^)]*)\)/i;
    const match = re.exec(createTs);
    expect(match).not.toBeNull();
    const arbiterStatuses = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(arbiterStatuses.sort()).toEqual([...LIVE_PREPARATION_STATUSES].sort());
  });
});
