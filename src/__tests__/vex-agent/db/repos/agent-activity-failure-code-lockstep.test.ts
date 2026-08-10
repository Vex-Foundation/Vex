/**
 * Lockstep guard (W5 design §1/R1, K1 card deliverable): the SQL
 * `agent_activity_failure_code_valid` CHECK (widened in migration
 * `049_agent_activity_solana_vocabulary.sql`) and the TS repo-boundary
 * `CLOSED_FAILURE_CODES` set (`db/repos/agent-activity/validation.ts`) MUST
 * list the exact same closed vocabulary — a typo'd or forgotten code on
 * either side would let a value slip past ONE layer while the other rejects
 * it (the CHECK is the belt-and-suspenders backstop for the TS boundary
 * guard, per validation.ts's own doc comment).
 *
 * Parses the constraint text straight out of the migration SOURCE files (not
 * a build artifact), same discipline as
 * `src/__tests__/vex-agent/memory/schema/_lockstep.ts`. `045_bridge_activity.sql`
 * introduced the NAMED constraint `agent_activity_failure_code_valid`; 049
 * DROPs and re-ADDs it widened (R1) — the LAST definition in migration order
 * is the live one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";
import { CLOSED_FAILURE_CODES } from "../../../../vex-agent/db/repos/agent-activity/validation.js";

function readMigration(filename: string): string {
  return readFileSync(
    join(getPackageRoot(), "src", "vex-agent", "db", "migrations", filename),
    "utf-8",
  );
}

const MIGRATION_SQL = [
  readMigration("045_bridge_activity.sql"),
  readMigration("049_agent_activity_solana_vocabulary.sql"),
  readMigration("076_agent_activity_venue_unavailable.sql"),
].join("\n");

/** Extract the LAST `CONSTRAINT agent_activity_failure_code_valid CHECK (failure_code IN (...))` value list. */
function parseFailureCodeCheck(sql: string): string[] {
  const re = /CONSTRAINT\s+agent_activity_failure_code_valid\s+CHECK\s*\(\s*failure_code\s+IN\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(sql)) !== null) {
    last = match;
  }
  if (!last) {
    throw new Error("lockstep: 'agent_activity_failure_code_valid' CHECK not found");
  }
  return last[1]!
    .split(",")
    .map((token) => token.trim().replace(/^'(.*)'$/, "$1"))
    .filter((token) => token.length > 0);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("agent_activity.failure_code — SQL CHECK <-> TS CLOSED_FAILURE_CODES lockstep", () => {
  it("the SQL CHECK and the TS closed set list the exact same codes", () => {
    const sqlCodes = parseFailureCodeCheck(MIGRATION_SQL);
    const tsCodes = [...CLOSED_FAILURE_CODES];
    expect(sorted(tsCodes)).toEqual(sorted(sqlCodes));
  });

  it("includes the W5 addition 'solana_signature_expired' on both sides", () => {
    const sqlCodes = parseFailureCodeCheck(MIGRATION_SQL);
    expect(sqlCodes).toContain("solana_signature_expired");
    expect(CLOSED_FAILURE_CODES.has("solana_signature_expired")).toBe(true);
  });

  it("never re-introduces the design's dropped/invented codes (R1 correction)", () => {
    const sqlCodes = parseFailureCodeCheck(MIGRATION_SQL);
    for (const invented of [
      "provider_rejected",
      "slippage_exceeded",
      "pre_broadcast_failure",
      "confirmation_unknown_exhausted",
      "market_closed",
      "position_not_found",
      "insufficient_collateral",
    ]) {
      expect(sqlCodes).not.toContain(invented);
      expect(CLOSED_FAILURE_CODES.has(invented)).toBe(false);
    }
  });
});
