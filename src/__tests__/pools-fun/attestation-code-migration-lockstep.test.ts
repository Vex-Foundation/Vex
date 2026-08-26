/**
 * VOCABULARY ↔ CHECK LOCKSTEP for the pools.fun attestation rejection codes.
 *
 * The terminal codes live in TWO places that must stay identical:
 *
 *   1. `@tools/pools-fun/attribution-codes.ts` - `POOLS_ATTEST_TERMINAL_CODES`,
 *      which the client classifies against and the sweep decides from;
 *   2. the CHECK constraint on the rejection-code column in
 *      `db/migrations/094_pools_launch_attribution.sql`, which the DATABASE
 *      enforces at write time.
 *
 * Drift between them is invisible until it is expensive. A code added to the
 * tuple but not the CHECK makes `markPoolsAttributionRejected` throw inside the
 * sweep, days later, for one specific partner answer nobody can reproduce; a
 * code removed from the tuple but left in the CHECK leaves a durable value no
 * reader can classify. Neither shows up in a typecheck.
 *
 * WHY A LOCAL PARSER. `memory/schema/_lockstep.ts` already parses CHECK value
 * lists, but it pins `MIGRATION_SQL` to two specific memory migrations and is
 * owned by that lane. This file needs one different migration and stays
 * constraint-name agnostic (the name belongs to the migration; the VALUE SET
 * is the shared contract), so it reads the file and extracts the quoted
 * literals from the CHECK that mentions the codes.
 *
 * MIGRATION 094 IS REQUIRED. A missing migration file is a red test, never a
 * skip: the vocabulary module and the CHECK ship as one contract, and a build
 * that has one without the other is exactly the drift this file exists to
 * catch.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getPackageRoot } from "@utils/package-assets.js";
import {
  POOLS_ATTEST_LANE_MISCONFIG_CODE,
  POOLS_ATTEST_RETRYABLE_CODES,
  POOLS_ATTEST_TERMINAL_CODES,
  isPoolsAttestRetryableCode,
  isPoolsAttestTerminalCode,
} from "@tools/pools-fun/attribution-codes.js";

const MIGRATION_FILE = join(
  getPackageRoot(),
  "src",
  "vex-agent",
  "db",
  "migrations",
  "094_pools_launch_attribution.sql",
);

const migrationExists = existsSync(MIGRATION_FILE);

/**
 * The quoted literals of the LAST `CHECK (... IN (...))` in `sql` that mentions
 * a known terminal code. Constraint-name agnostic on purpose: the name belongs
 * to the migration's author, the VALUE SET is the shared contract.
 */
function parseTerminalCodeCheck(sql: string): string[] | null {
  const re = /CHECK\s*\([^)]*?IN\s*\(([^)]*)\)/gis;
  let match: RegExpExecArray | null;
  let last: string[] | null = null;
  while ((match = re.exec(sql)) !== null) {
    const values = [...(match[1] ?? "").matchAll(/'([^']*)'/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    if (values.some((v) => (POOLS_ATTEST_TERMINAL_CODES as readonly string[]).includes(v))) {
      last = values;
    }
  }
  return last;
}

describe("the pools attestation code vocabulary is internally coherent", () => {
  it("has a non-empty terminal set", () => {
    expect(POOLS_ATTEST_TERMINAL_CODES.length).toBeGreaterThan(0);
  });

  it("keeps terminal and retryable DISJOINT - a code cannot mean both", () => {
    const overlap = POOLS_ATTEST_TERMINAL_CODES.filter((code) =>
      (POOLS_ATTEST_RETRYABLE_CODES as readonly string[]).includes(code),
    );
    expect(overlap).toEqual([]);
  });

  it("classifies every terminal code as terminal and nothing else", () => {
    for (const code of POOLS_ATTEST_TERMINAL_CODES) {
      expect(isPoolsAttestTerminalCode(code)).toBe(true);
      expect(isPoolsAttestRetryableCode(code)).toBe(false);
    }
  });

  it("classifies every retryable code as retryable and nothing else", () => {
    for (const code of POOLS_ATTEST_RETRYABLE_CODES) {
      expect(isPoolsAttestRetryableCode(code)).toBe(true);
      expect(isPoolsAttestTerminalCode(code)).toBe(false);
    }
  });

  it("names the lane-misconfiguration code inside the retryable set", () => {
    expect(POOLS_ATTEST_RETRYABLE_CODES).toContain(POOLS_ATTEST_LANE_MISCONFIG_CODE);
  });

  it("rejects an unknown code from both sets - an unreadable answer is neither", () => {
    for (const value of ["teapot_overheated", "", null, undefined, 42, {}]) {
      expect(isPoolsAttestTerminalCode(value)).toBe(false);
      expect(isPoolsAttestRetryableCode(value)).toBe(false);
    }
  });
});

describe(
  "migration 094's CHECK and POOLS_ATTEST_TERMINAL_CODES are the same set",
  () => {
    it("the migration file exists - 094 is REQUIRED, a missing file is a red test not a skip", () => {
      expect(migrationExists, `expected ${MIGRATION_FILE} to exist`).toBe(true);
    });

    it("finds a terminal-code CHECK in the migration at all", () => {
      expect(
        parseTerminalCodeCheck(readFileSync(MIGRATION_FILE, "utf-8")),
        `no CHECK (... IN (...)) mentioning a terminal code found in ${MIGRATION_FILE}`,
      ).not.toBeNull();
    });

    it("has EXACTLY the terminal set - no extra value, no missing value", () => {
      const checked = parseTerminalCodeCheck(readFileSync(MIGRATION_FILE, "utf-8")) ?? [];
      expect([...checked].sort()).toEqual([...POOLS_ATTEST_TERMINAL_CODES].sort());
    });

    it("does NOT admit a retryable code - those never reach the rejection column", () => {
      const checked = parseTerminalCodeCheck(readFileSync(MIGRATION_FILE, "utf-8")) ?? [];
      const leaked = checked.filter((v) =>
        (POOLS_ATTEST_RETRYABLE_CODES as readonly string[]).includes(v),
      );
      expect(leaked).toEqual([]);
    });
  },
);
