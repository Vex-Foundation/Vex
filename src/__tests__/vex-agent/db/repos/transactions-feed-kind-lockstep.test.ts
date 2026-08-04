/**
 * THE CLASS-KILLER. Every `kind` the `agent_activity` CHECK constraint accepts
 * must be KNOWN to both agent-facing feeds — the engine's `transactions` feed
 * (`transactions-query-builder.ts`) and the app's Agent Scan feed
 * (`vex-app/src/main/database/agent-scan-db-query.ts`).
 *
 * WHY. The same defect shipped twice. Migration 051 added `wrap` and migration
 * 053 added `yield`; both were written correctly by the handlers, proven live
 * on-chain, and then read by NOBODY: the feed predicates still listed only the
 * kinds that existed when they were written. For `yield` the failure mode was
 * worse than invisibility — a FAILED Pendle attempt reached the feed through
 * the failure half (which knows the `yield` product) while every SUCCESSFUL one
 * did not, so the agent saw a Pendle history made of losses only.
 *
 * A kind is "known" when all four hold:
 *   1. the activity half's row predicate admits it;
 *   2. it has a `productType` filter arm (so the filter cannot silently exclude
 *      the whole half);
 *   3. the `product_type` projection names it (so it cannot fall through to
 *      `ELSE 'spot'` and be rendered as a spot trade it never was);
 *   4. the app feed's LOGICAL_ROW_PREDICATE admits it.
 *
 * A new migration that widens the kind vocabulary therefore FAILS this test
 * until both feeds are taught the kind — which is the whole point. The
 * `KIND_PRODUCT` map below is the deliberate decision point: adding a kind
 * forces someone to name the product it renders as, rather than inheriting
 * `spot` by accident.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";

const ROOT = getPackageRoot();
const MIGRATIONS_DIR = join(ROOT, "src", "vex-agent", "db", "migrations");

const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf-8"))
  .join("\n");

const QUERY_BUILDER_SRC = readFileSync(
  join(ROOT, "src", "vex-agent", "db", "repos", "transactions-query-builder.ts"),
  "utf-8",
);

const AGENT_SCAN_SRC = readFileSync(
  join(ROOT, "vex-app", "src", "main", "database", "agent-scan-db-query.ts"),
  "utf-8",
);

/** The LAST `agent_activity_kind_valid` CHECK in migration order is the live one. */
function liveKinds(): string[] {
  const re =
    /CONSTRAINT\s+agent_activity_kind_valid\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(MIGRATION_SQL)) !== null) last = match;
  if (!last) throw new Error("lockstep: agent_activity_kind_valid CHECK not found");
  return last[1]
    .split(",")
    .map((token) => token.trim().replace(/^'(.*)'$/, "$1"))
    .filter((token) => token.length > 0);
}

/**
 * The product each kind renders as in the transactions feed. `swap` is the ONE
 * kind the projection's `ELSE` arm legitimately covers, so it is excluded from
 * the projection assertion (and only from that one).
 */
const KIND_PRODUCT: Readonly<Record<string, string>> = {
  swap: "spot",
  bridge: "bridge",
  lend: "lend",
  prediction: "prediction",
  wrap: "wrap",
  yield: "yield",
  launch: "launch",
};

/** The activity half's row predicate, read from the source it is written in. */
function activityRowPredicate(): string {
  const match = /activityConds\.push\(\s*"(\(kind = 'swap'[^"]*)"/.exec(QUERY_BUILDER_SRC);
  if (!match) throw new Error("lockstep: the activity-half row predicate was not found");
  return match[1];
}

/** The `product_type` CASE expression of the activity half's SELECT. */
function productTypeProjection(): string {
  const match = /CASE\n([\s\S]*?)END AS product_type/.exec(QUERY_BUILDER_SRC);
  if (!match) throw new Error("lockstep: the product_type projection was not found");
  return match[1];
}

/** The app feed's LOGICAL_ROW_PREDICATE literal. */
function logicalRowPredicate(): string {
  // The literal is now built by `logicalRowPredicate(alias)` so the Vex-fee
  // LATERAL can exclude a fee leg that is ALREADY its own ledger entry using
  // the very same rule — one predicate, two callers, no drift.
  const match = /function logicalRowPredicate\(alias: string\): string \{\s*return `([\s\S]*?)`;/
    .exec(AGENT_SCAN_SRC);
  const body = match?.[1];
  if (body === undefined) throw new Error("lockstep: LOGICAL_ROW_PREDICATE was not found");
  // Read the predicate as the feed itself reads it, with the alias resolved.
  return body.replaceAll("${alias}", "aa");
}

describe("agent_activity kind <-> agent-facing feed lockstep", () => {
  it("every kind in the live CHECK has a declared product", () => {
    // Fails FIRST when a migration widens the vocabulary, and says why: the
    // product a new kind renders as is a decision, never a default.
    for (const kind of liveKinds()) {
      expect(KIND_PRODUCT[kind], `kind '${kind}' has no declared feed product`).toBeDefined();
    }
  });

  it("the transactions activity half admits every kind", () => {
    const predicate = activityRowPredicate();
    for (const kind of liveKinds()) {
      // A bridge execution fans out into legs; only its logical row is a feed
      // row, so it is admitted by role rather than by kind.
      const expected =
        kind === "bridge" ? "event_role = 'bridge_fill_expected'" : `kind = '${kind}'`;
      expect(predicate, `activity half does not admit kind '${kind}'`).toContain(expected);
    }
  });

  it("every kind has a productType filter arm", () => {
    for (const kind of liveKinds()) {
      const product = KIND_PRODUCT[kind];
      expect(
        QUERY_BUILDER_SRC,
        `productType='${product}' has no arm — the filter would exclude the whole activity half`,
      ).toContain(`productType === "${product}"`);
      expect(QUERY_BUILDER_SRC).toContain(`activityConds.push("kind = '${kind}'")`);
    }
  });

  it("every kind is named by the product_type projection — never left to ELSE 'spot'", () => {
    const projection = productTypeProjection();
    for (const kind of liveKinds()) {
      if (kind === "swap") continue; // the one kind ELSE 'spot' legitimately covers
      expect(
        projection,
        `kind '${kind}' falls through to ELSE 'spot' — it would render as a spot trade`,
      ).toContain(`WHEN kind = '${kind}' THEN '${KIND_PRODUCT[kind]}'`);
    }
  });

  it("the Agent Scan feed's logical-row predicate admits every kind", () => {
    const predicate = logicalRowPredicate();
    for (const kind of liveKinds()) {
      if (kind === "swap") {
        expect(predicate).toContain("aa.event_role = 'swap'");
        continue;
      }
      if (kind === "bridge") {
        expect(predicate).toContain("aa.event_role = 'bridge_fill_expected'");
        continue;
      }
      expect(
        predicate,
        `Agent Scan does not admit kind '${kind}' — it is written and invisible`,
      ).toContain(`'${kind}'`);
    }
  });
});
