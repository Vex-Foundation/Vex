/**
 * Generic Vex-fee planning is UNREACHABLE from a wrap intent.
 *
 * ## Why this is a structural test and not a behavioural one
 *
 * The guarantee here is the ABSENCE of a code path, and absence is the one
 * property no behavioural test can demonstrate. A test that prepared a wrap and
 * asserted "no fee leg was written" would prove exactly one thing: that the
 * inputs it happened to choose did not reach the fee planner on the day it ran.
 * It could not distinguish "there is no way to get there" from "I did not find
 * the way", and the input space that would have to be exhausted to close that
 * gap is unbounded.
 *
 * What CAN be decided mechanically is whether the edge exists at all. A module
 * cannot invoke code it never imports, so an import-graph assertion over the
 * lane's own sources turns an open-ended search into a closed question. The same
 * reasoning applies to the durable side: a fee cannot be persisted through a
 * column that does not exist, and a fee cannot be carried through a DTO field
 * that is not declared.
 *
 * The three locks asserted below are deliberately redundant, and each one is
 * checked separately so a failure names which lock was opened:
 *
 *   1. the wrap lane's sources import neither fee module;
 *   2. `WalletWrapIntent` declares no fee-shaped property;
 *   3. migration 096 declares no fee column.
 *
 * Adding a Vex fee to this path is therefore not a small edit anyone could make
 * by accident: it requires editing the contract, the migration and the lane
 * together, and this test is what forces that to be a deliberate act.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");
const WRAP_LANE = resolve(ROOT, "src", "vex-agent", "tools", "internal", "wallet", "wrap");
const WRAP_CONTRACT = resolve(ROOT, "src", "vex-agent", "db", "contracts", "wallet-wrap-intent.ts");
const WRAP_ROW = resolve(
  ROOT, "src", "vex-agent", "db", "repos", "wallet-wrap-intents", "row.ts",
);
const MIGRATION_096 = resolve(
  ROOT, "src", "vex-agent", "db", "migrations", "096_wallet_wrap_intents.sql",
);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function repoPath(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

/**
 * Comments describe the absence in prose all over this lane, and prose is not an
 * import. Only real code is evidence of an edge.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
}

const LANE_FILES = sourceFiles(WRAP_LANE);

// ── Lock 1: the import graph ──────────────────────────────────────────

describe("the wrap lane cannot reach generic Vex-fee planning", () => {
  it("has lane sources to inspect, so the assertions below are not vacuous", () => {
    expect(LANE_FILES.length).toBeGreaterThan(0);
  });

  const FEE_MODULES = ["transaction/vex-fee.js", "transaction/vex-fee-collection.js"] as const;

  for (const module of FEE_MODULES) {
    it(`imports nothing from \`${module}\``, () => {
      const offenders = LANE_FILES.filter((file) =>
        withoutComments(readFileSync(file, "utf8")).includes(module),
      ).map(repoPath);
      expect(offenders).toEqual([]);
    });
  }

  it("references no fee-planning symbol under any import spelling", () => {
    // A defence against the obvious way around the two checks above: the same
    // module reached by a different specifier, a dynamic import, or a re-export.
    const pattern = /vex-fee|VexFee|vexFee|planVexFee|collectVexFee/;
    const offenders = LANE_FILES.filter((file) =>
      pattern.test(withoutComments(readFileSync(file, "utf8"))),
    ).map(repoPath);
    expect(offenders).toEqual([]);
  });
});

// ── Lock 2: the durable DTO ───────────────────────────────────────────

describe("the wrap intent contract declares no fee-shaped field", () => {
  it("declares no fee property on WalletWrapIntent", () => {
    const source = withoutComments(readFileSync(WRAP_ROW, "utf8"));
    const block = source.slice(source.indexOf("export interface WalletWrapIntent"));
    const body = block.slice(0, block.indexOf("}") + 1);

    const declared = [...body.matchAll(/readonly\s+([A-Za-z0-9_]+)\s*[?:]/g)].map(
      (match) => match[1],
    );
    expect(declared.length).toBeGreaterThan(0);

    // `feeBounds` is the NETWORK gas ceiling the user authorizes: the chain's
    // charge, not Vex's, and its presence is required. Every other fee-shaped
    // name is forbidden.
    const feeShaped = declared.filter((name) => /fee/i.test(name)).sort();
    expect(feeShaped).toEqual(["feeBounds"]);
  });

  it("declares no fee property on the create input either", () => {
    const source = withoutComments(readFileSync(WRAP_ROW, "utf8"));
    const block = source.slice(source.indexOf("export interface CreateWalletWrapIntentInput"));
    const body = block.slice(0, block.indexOf("}") + 1);
    const declared = [...body.matchAll(/readonly\s+([A-Za-z0-9_]+)\s*[?:]/g)].map(
      (match) => match[1],
    );
    expect(declared.filter((name) => /fee/i.test(name)).sort()).toEqual(["feeBounds"]);
  });

  it("defines no fee schema in the durable contract module", () => {
    const source = withoutComments(readFileSync(WRAP_CONTRACT, "utf8"));
    expect(source).not.toMatch(/vexFee|VexFeeSchema|feeAmountRaw|feeReceiver|feeBps/);
  });
});

// ── Lock 3: the migration ─────────────────────────────────────────────

describe("migration 096 declares no fee column", () => {
  const sql = readFileSync(MIGRATION_096, "utf8");

  /** SQL comments are prose about the absence; the DDL is the fact. */
  const ddl = sql.replace(/--[^\n]*/g, "");

  it("declares columns, so the assertion below is not vacuous", () => {
    expect(ddl).toContain("CREATE TABLE");
    expect(ddl).toContain("fee_bounds_json");
  });

  it("declares fee_bounds_json and no other fee-named column", () => {
    // Every identifier in the DDL that mentions a fee. `fee_bounds_json` is the
    // authorized NETWORK gas ceiling; anything else would be a charge with a
    // durable home, which is exactly what must not exist.
    const feeIdentifiers = [...ddl.matchAll(/\b([a-z0-9_]*fee[a-z0-9_]*)\b/gi)]
      .map((match) => match[1].toLowerCase());
    expect([...new Set(feeIdentifiers)].sort()).toEqual(["fee_bounds_json"]);
  });
});
