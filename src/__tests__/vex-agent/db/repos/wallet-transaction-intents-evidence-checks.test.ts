/**
 * Migration 087's evidence CHECKs, evaluated against concrete rows.
 *
 * These are not text assertions. The constraint bodies are parsed OUT of the
 * migration source as written and run through the repo suite's SQL check
 * evaluator, which answers the only question that matters: "would Postgres
 * accept this row?". A test that asserted the file contains a substring could
 * not catch an arm that accidentally admits a `failed` row carrying a hash it
 * never earned, and that row is exactly the shape the transfer table already
 * produces and the money-state gate has to treat as unresolved.
 *
 * Every row in the tables below is a line of the A4b transition table T1-T8.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { evaluateSqlCheck, type SqlRow } from "./_sql-check-eval.js";

const MIGRATION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../vex-agent/db/migrations/087_wallet_transaction_intents.sql",
  ),
  "utf-8",
);

/**
 * Extract an INLINE `CONSTRAINT <name> CHECK ( ... )` body from a CREATE TABLE.
 *
 * `_sql-check-eval.ts`'s own extractor reads the `ALTER TABLE ... ADD
 * CONSTRAINT` form, which is how migrations that widen an existing table are
 * written. 087 creates its table, so its constraints are inline; the balancing
 * logic is the same and lives here rather than widening the shared helper for
 * one caller.
 */
function inlineCheckBody(sql: string, constraintName: string): string {
  const anchor = new RegExp(`CONSTRAINT\\s+${constraintName}\\s+CHECK\\s*\\(`, "i");
  const match = anchor.exec(sql);
  if (match === null) throw new Error(`constraint '${constraintName}' not found`);
  const start = match.index + match[0].length;
  let depth = 1;
  let inString = false;
  for (let i = start; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") inString = false;
    } else if (ch === "'") {
      inString = true;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(start, i);
    }
  }
  throw new Error(`unbalanced CHECK body for '${constraintName}'`);
}

/**
 * Drop `--` line comments before evaluation. The constraints carry their
 * reasoning inline, which is where it belongs and which the evaluator's
 * tokenizer does not model; stripping them here keeps the migration readable
 * without widening a shared helper.
 */
function withoutComments(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

const EVIDENCE = withoutComments(inlineCheckBody(MIGRATION, "wallet_transaction_intents_evidence"));
const FAILED_EVIDENCE = withoutComments(
  inlineCheckBody(MIGRATION, "wallet_transaction_intents_failed_evidence"),
);
const FAILURE_STAGE = withoutComments(
  inlineCheckBody(MIGRATION, "wallet_transaction_intents_failure_stage"),
);
const FAMILY_CHAIN = withoutComments(
  inlineCheckBody(MIGRATION, "wallet_transaction_intents_family_chain"),
);

function row(status: string, txHash: string | null, failureStage: string | null): SqlRow {
  return { status, tx_hash: txHash, failure_stage: failureStage };
}

const HASH = "0xdeadbeef";

describe("087 evidence CHECK - the statuses that are not `failed`", () => {
  const accepted: readonly [string, SqlRow][] = [
    ["T1 prepare inserts pending with no hash", row("pending", null, null)],
    ["T2 claim moves to consuming with no hash yet", row("consuming", null, null)],
    ["T3a executed carries definitive evidence", row("executed", HASH, null)],
    ["T3d/T4b broadcast_unconfirmed carries the staged hash", row("broadcast_unconfirmed", HASH, null)],
    ["T6 superseded_unproven retains the hash", row("superseded_unproven", HASH, null)],
    ["T7 expired never broadcast", row("expired", null, null)],
    ["T8 cancelled never broadcast", row("cancelled", null, null)],
    ["audit_failed means the staged write broke BEFORE broadcast", row("audit_failed", null, null)],
  ];
  for (const [name, candidate] of accepted) {
    it(`accepts: ${name}`, () => {
      expect(evaluateSqlCheck(EVIDENCE, candidate)).toBe(true);
    });
  }

  const rejected: readonly [string, SqlRow][] = [
    ["a pending row with a hash claims a broadcast that cannot have happened", row("pending", HASH, null)],
    ["a consuming row with a hash escapes the staged-evidence ordering", row("consuming", HASH, null)],
    ["an executed row with NO hash asserts success it cannot prove", row("executed", null, null)],
    ["broadcast_unconfirmed with no hash has nothing to reconcile against", row("broadcast_unconfirmed", null, null)],
    ["superseded_unproven with no hash has nothing to investigate", row("superseded_unproven", null, null)],
    ["audit_failed with a hash would mean something WAS signed", row("audit_failed", HASH, null)],
    ["cancelled with a hash is a contradiction", row("cancelled", HASH, null)],
    ["expired with a hash is a contradiction", row("expired", HASH, null)],
    ["a non-failed row may not carry a failure stage", row("executed", HASH, "chain_reverted")],
  ];
  for (const [name, candidate] of rejected) {
    it(`rejects: ${name}`, () => {
      expect(evaluateSqlCheck(EVIDENCE, candidate)).toBe(false);
    });
  }
});

describe("087 evidence CHECK - `failed` splits by stage", () => {
  it("T3b a chain revert REQUIRES the hash the operator reads the receipt from", () => {
    expect(evaluateSqlCheck(FAILED_EVIDENCE, row("failed", HASH, "chain_reverted"))).toBe(true);
    expect(evaluateSqlCheck(FAILED_EVIDENCE, row("failed", null, "chain_reverted"))).toBe(false);
  });

  it("T3c a pre-broadcast failure REQUIRES no hash", () => {
    expect(evaluateSqlCheck(FAILED_EVIDENCE, row("failed", null, "pre_broadcast"))).toBe(true);
    // This is the row shape `wallet_intents` permits and 087 does not: a
    // failure carrying a hash is indistinguishable from a revert, and a caller
    // who reads "failed" retries.
    expect(evaluateSqlCheck(FAILED_EVIDENCE, row("failed", HASH, "pre_broadcast"))).toBe(false);
  });

  it("T4a a crash before broadcast REQUIRES no hash", () => {
    expect(
      evaluateSqlCheck(FAILED_EVIDENCE, row("failed", null, "crashed_before_broadcast")),
    ).toBe(true);
    expect(
      evaluateSqlCheck(FAILED_EVIDENCE, row("failed", HASH, "crashed_before_broadcast")),
    ).toBe(false);
  });
});

describe("087 failure-stage CHECK", () => {
  it("a `failed` row must name its stage, and no other status may", () => {
    expect(evaluateSqlCheck(FAILURE_STAGE, row("failed", HASH, "chain_reverted"))).toBe(true);
    expect(evaluateSqlCheck(FAILURE_STAGE, row("failed", null, null))).toBe(false);
    expect(evaluateSqlCheck(FAILURE_STAGE, row("executed", HASH, null))).toBe(true);
    expect(evaluateSqlCheck(FAILURE_STAGE, row("executed", HASH, "pre_broadcast"))).toBe(false);
  });
});

describe("087 family/chain CHECK", () => {
  function familyRow(
    family: string,
    chainAlias: string | null,
    chainId: string | null,
    blockhash: string | null,
    height: string | null,
  ): SqlRow {
    return {
      family,
      chain_alias: chainAlias,
      chain_id: chainId,
      recent_blockhash: blockhash,
      last_valid_block_height: height,
    };
  }

  it("an EVM intent names its chain both ways and carries no blockhash", () => {
    expect(evaluateSqlCheck(FAMILY_CHAIN, familyRow("eip155", "base", "8453", null, null))).toBe(true);
    expect(evaluateSqlCheck(FAMILY_CHAIN, familyRow("eip155", null, "8453", null, null))).toBe(false);
    expect(evaluateSqlCheck(FAMILY_CHAIN, familyRow("eip155", "base", null, null, null))).toBe(false);
    expect(evaluateSqlCheck(FAMILY_CHAIN, familyRow("eip155", "base", "8453", "hash", "1"))).toBe(false);
  });

  it("a Solana intent MUST carry its height evidence, because confirm rechecks it", () => {
    expect(evaluateSqlCheck(FAMILY_CHAIN, familyRow("solana", null, null, "hash", "1"))).toBe(true);
    expect(evaluateSqlCheck(FAMILY_CHAIN, familyRow("solana", null, null, null, null))).toBe(false);
    expect(evaluateSqlCheck(FAMILY_CHAIN, familyRow("solana", null, null, "hash", null))).toBe(false);
    expect(evaluateSqlCheck(FAMILY_CHAIN, familyRow("solana", null, "8453", "hash", "1"))).toBe(false);
  });
});
