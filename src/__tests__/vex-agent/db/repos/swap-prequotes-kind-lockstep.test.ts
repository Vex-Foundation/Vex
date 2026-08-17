/**
 * Lockstep guard, sibling of `agent-activity-kind-role-lockstep.test.ts`: the SQL
 * `swap_prequotes_kind_check` CHECK and the TypeScript `PrequoteKind` union
 * (`db/repos/swap-prequotes.ts`) MUST list the exact same vocabulary.
 *
 * WHY. `kind` is not a label — it is a predicate in BOTH gate reads
 * (`findLatestFreshByMatch`, `existsFreshFailByMatch`). The two sides drift in
 * two directions and BOTH are quiet:
 *
 *   - TS ahead of SQL: a recorder names a kind Postgres rejects. The insert
 *     throws inside a best-effort recorder that swallows it, so the dry run looks
 *     fine and the later execute blocks with "no fresh dry run" — a bug that
 *     presents as an unrelated gate message.
 *   - SQL ahead of TS: a writer cannot name the kind at all, and `mapRow` casts
 *     the DB string into a union that does not contain it.
 *
 * Neither is catchable at runtime (a TYPE cannot be asserted), and migration 054
 * exists precisely because one such shortcut (`sy_mint`/`sy_redeem` stored under
 * `'swap'`) survived a green suite. Both sides are parsed from SOURCE — every
 * migration file in application order, where the LAST definition of the
 * constraint is the live one.
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

const REPO_TS = readFileSync(
  join(getPackageRoot(), "src", "vex-agent", "db", "repos", "swap-prequotes.ts"),
  "utf-8",
);

/**
 * Extract the LAST `CONSTRAINT swap_prequotes_kind_check CHECK (kind IN (...))`
 * value list. Comment lines are stripped first so a kind merely NAMED in a
 * migration's prose can never be mistaken for one the constraint admits.
 */
function parseKindCheck(): string[] {
  const sqlWithoutComments = MIGRATION_SQL.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const re =
    /CONSTRAINT\s+swap_prequotes_kind_check\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(sqlWithoutComments)) !== null) {
    last = match;
  }
  if (!last) {
    throw new Error("lockstep: 'swap_prequotes_kind_check' CHECK not found in the migrations");
  }
  return last[1]!
    .split(",")
    .map((token) => token.trim().replace(/^'(.*)'$/, "$1"))
    .filter((token) => token.length > 0);
}

/** Extract the string-literal members of `export type PrequoteKind = ... ;`. */
function parseKindUnion(): string[] {
  const match = /export type PrequoteKind =([^;]*);/.exec(REPO_TS);
  if (!match) {
    throw new Error("lockstep: TS union 'PrequoteKind' not found in swap-prequotes.ts");
  }
  const members = match[1]!.match(/"([^"]+)"/g);
  if (!members) {
    throw new Error("lockstep: TS union 'PrequoteKind' has no string members");
  }
  return members.map((member) => member.slice(1, -1));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("swap_prequotes kind — SQL CHECK <-> TS union lockstep", () => {
  it("the SQL kind CHECK and PrequoteKind list the exact same kinds", () => {
    expect(sorted(parseKindUnion())).toEqual(sorted(parseKindCheck()));
  });

  it("the R5d kinds are present on BOTH sides (migration 054)", () => {
    const r5d = [
      "sy_mint",
      "sy_redeem",
      "lp_remove_dual",
      "lp_add_keep_yt",
      "pt_rollover",
      "lp_transfer",
      "lp_to_pt",
    ];
    const sql = parseKindCheck();
    const ts = parseKindUnion();
    for (const kind of r5d) {
      expect(sql, `${kind} missing from the SQL CHECK`).toContain(kind);
      expect(ts, `${kind} missing from PrequoteKind`).toContain(kind);
    }
  });

  it("the Morpho vault lend kinds are present on BOTH sides (migration 080)", () => {
    // One kind per DIRECTION, mirroring 'lp_add' / 'lp_remove': a shared kind
    // would let a deposit quote authorize a withdraw execute.
    const sql = parseKindCheck();
    const ts = parseKindUnion();
    for (const kind of ["lend_deposit", "lend_withdraw"]) {
      expect(sql, `${kind} missing from the SQL CHECK`).toContain(kind);
      expect(ts, `${kind} missing from PrequoteKind`).toContain(kind);
    }
  });

  it("neither lend direction collapsed into 'swap' (054's rationale, restated by 080)", () => {
    // The bug 054 fixed was a protocol write filed under 'swap', where an
    // ordinary DEX quote can authorize it. 'swap' must stay exactly one kind.
    expect(parseKindCheck().filter((kind) => kind === "swap")).toHaveLength(1);
    expect(parseKindUnion().filter((kind) => kind === "swap")).toHaveLength(1);
  });

  it("the pre-080 vocabulary is preserved - 080 is expand-only", () => {
    // A kind dropped from the CHECK would make every live row of that kind
    // unwritable; this pins that 080 only widened.
    for (const kind of [
      "sy_mint",
      "sy_redeem",
      "lp_remove_dual",
      "lp_add_keep_yt",
      "pt_rollover",
      "lp_transfer",
      "lp_to_pt",
    ]) {
      expect(parseKindCheck(), `${kind} was dropped from the CHECK`).toContain(kind);
    }
  });

  it("the pre-R5d vocabulary is preserved — 054 is expand-only", () => {
    // A kind dropped from the CHECK would make every live row of that kind
    // unwritable; this pins that 054 only widened.
    for (const kind of ["swap", "bridge", "redeem", "mint", "redeem_py", "lp_add", "lp_remove"]) {
      expect(parseKindCheck(), `${kind} was dropped from the CHECK`).toContain(kind);
    }
  });

  it("no kind is listed twice on either side", () => {
    const sql = parseKindCheck();
    const ts = parseKindUnion();
    expect(new Set(sql).size, "duplicate kind in the SQL CHECK").toBe(sql.length);
    expect(new Set(ts).size, "duplicate kind in PrequoteKind").toBe(ts.length);
  });
});
