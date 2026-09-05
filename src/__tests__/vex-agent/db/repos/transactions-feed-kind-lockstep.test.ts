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
 *   4. the app feed's positive logical-role predicate admits its user actions.
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

const LOGICAL_ROW_SRC = readFileSync(
  join(ROOT, "vex-app", "src", "main", "database", "agent-activity-logical-row.ts"),
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
  // Migration 082. A creator-fee claim renders as its OWN product: it pays two
  // assets out from a token that already exists, so filing it as a launch would
  // put a payout inside every launch view.
  claim: "claim",
  // Migration 084. A wallet send renders as its OWN product: it moves one asset
  // to an address with no route, price or counterparty, so the `ELSE` arm's
  // "spot" would state a trade that never happened.
  transfer: "transfer",
  // Migration 087. A generic signed transaction renders as its OWN product: an
  // approval or an arbitrary contract call has no asset leg to state, so both
  // the `ELSE` arm's "spot" and the `transfer` product would describe a
  // movement nobody proved.
  transaction: "transaction",
};

/** Every current user-action role per kind; plumbing roles are intentionally absent. */
const KIND_LOGICAL_ROLES: Readonly<Record<string, readonly string[]>> = {
  swap: ["swap"],
  bridge: ["bridge_fill_expected"],
  lend: ["lend_deposit", "lend_withdraw", "lend_borrow_operate"],
  prediction: ["predict_buy", "predict_sell", "predict_claim", "predict_close"],
  wrap: ["wrap", "unwrap"],
  yield: [
    "yield_pt",
    "yield_yt",
    "yield_py",
    "yield_lp",
    "yield_sy",
    "yield_claim",
  ],
  launch: ["token_launch"],
  claim: ["pools_claim"],
  transfer: ["wallet_transfer"],
  transaction: [
    "tx_approve",
    "tx_contract_call",
    "tx_native_transfer",
    "tx_spl_instruction_set",
  ],
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

/** The shared app-feed logical-row predicate literal. */
function logicalRowPredicate(): string {
  const match = /AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE = `([\s\S]*?)`;/.exec(LOGICAL_ROW_SRC);
  const body = match?.[1];
  if (body === undefined) throw new Error("lockstep: shared logical-row predicate was not found");
  return body;
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

  // OWNER REVISION 2026-08-05: a Vex-fee leg is not a user action and gets no
  // row of its own on EITHER feed. The live screenshot showed a "LAUNCH-FEE"
  // row above the launch it was 25 bps of; the charge belongs to its parent's
  // row, where both feeds project it from the confirmed leg.
  it("neither feed renders a Vex-fee leg as its own row", () => {
    // The agent half excludes them alongside the approval legs; `bridge_fee`
    // needs no entry there because its whole `kind = 'bridge'` arm is admitted
    // only through `event_role = 'bridge_fill_expected'`.
    expect(QUERY_BUILDER_SRC).toContain(
      "event_role NOT IN ('allowance', 'allowance_reset', 'trench_fee', 'swap_fee', 'pools_fee', 'tx_vex_fee', 'vex_fee')",
    );
    // The app feeds are positive-role only: every known technical role is
    // absent, and a future one therefore cannot become a row by default.
    for (const role of [
      "allowance",
      "allowance_reset",
      "bridge_fee",
      "swap_fee",
      "trench_fee",
      "pools_fee",
      // Migration 088. Unlike `bridge_fee`, its `kind = 'transaction'` arm IS
      // admitted by the agent half, so without the exclusion above the generic
      // lane's fee transfer would render as a second signed transaction beside
      // the one it charges for.
      "tx_vex_fee",
    ]) {
      expect(logicalRowPredicate()).not.toContain(`'${role}'`);
    }
  });

  it("the app feeds' logical-row predicate admits every user action for every kind", () => {
    const predicate = logicalRowPredicate();
    for (const kind of liveKinds()) {
      const roles = KIND_LOGICAL_ROLES[kind];
      expect(roles, `kind '${kind}' has no declared logical roles`).toBeDefined();
      for (const role of roles ?? []) {
        expect(
          predicate,
          `app feeds do not admit '${kind}' action role '${role}'`,
        ).toContain(`'${role}'`);
      }
    }
  });
});
