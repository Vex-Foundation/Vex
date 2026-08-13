/**
 * Kind lockstep for the THIRD local view: the app's per-token history
 * (`vex-app/src/main/database/token-history-db-query.ts`).
 *
 * `transactions-feed-kind-lockstep.test.ts` pins the two FEED views (the
 * engine's `transactions` feed and the app's Agent Scan feed). The token
 * history is a separate predicate with its own admission list, and it was
 * never pinned: the same defect that made `wrap` and `yield` write-only in the
 * feeds can recur here whenever a migration widens the `kind` vocabulary.
 *
 * Every kind in the live CHECK must therefore have a DECLARED verdict below:
 * either the SQL fragment that admits it, or an explicit record that this view
 * does not carry it. Adding a kind fails this test until someone decides which
 * of the two it is, and closing a known gap fails it too, so the record cannot
 * silently go stale.
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

const TOKEN_HISTORY_SRC = readFileSync(
  join(ROOT, "vex-app", "src", "main", "database", "token-history-db-query.ts"),
  "utf-8",
);

/** The LAST `agent_activity_kind_valid` CHECK in migration order is the live one. */
function liveKinds(): string[] {
  const re = /CONSTRAINT\s+agent_activity_kind_valid\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi;
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
 * How the token history admits each kind, as the SQL fragment that does it.
 *
 * `null` records a kind this view does NOT carry. `wrap` (migration 051) is the
 * one such kind today: neither `kind = 'wrap'` nor its `wrap`/`unwrap` roles
 * appear in the predicate, so a wrap or unwrap never shows in the history of
 * either token it moved. That is a gap in the view, recorded here rather than
 * fixed, because fixing it also requires a `product_type` arm and a mapper
 * decision about what a wrap renders as.
 */
const KIND_ADMISSION: Readonly<Record<string, string | null>> = {
  swap: "aa.event_role = 'swap'",
  bridge: "aa.event_role = 'bridge_fill_expected'",
  lend: "aa.kind IN ('lend', 'prediction', 'launch')",
  prediction: "aa.kind IN ('lend', 'prediction', 'launch')",
  launch: "aa.kind IN ('lend', 'prediction', 'launch')",
  yield: "'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_claim'",
  wrap: null,
};

/** The row-inclusion predicate of the agent_activity half. */
function rowInclusionPredicate(): string {
  const match = /aa\.wallet_address = ANY[\s\S]*?\n\s{8}AND \(\n([\s\S]*?)\n\s{8}\)/.exec(TOKEN_HISTORY_SRC);
  const body = match?.[1];
  if (body === undefined) throw new Error("lockstep: the token-history row-inclusion predicate was not found");
  return body;
}

describe("agent_activity kind <-> token history lockstep", () => {
  it("every kind in the live CHECK has a declared verdict for this view", () => {
    for (const kind of liveKinds()) {
      expect(
        Object.prototype.hasOwnProperty.call(KIND_ADMISSION, kind),
        `kind '${kind}' has no declared token-history verdict: admit it, or record it as not carried`,
      ).toBe(true);
    }
  });

  it("admits every kind it declares as carried", () => {
    const predicate = rowInclusionPredicate();
    for (const kind of liveKinds()) {
      const fragment = KIND_ADMISSION[kind];
      if (fragment === null) continue;
      expect(
        predicate,
        `token history does not admit kind '${kind}' - it is written and invisible on the token's page`,
      ).toContain(fragment);
    }
  });

  it("still does not carry the kinds recorded as gaps", () => {
    const predicate = rowInclusionPredicate();
    for (const kind of liveKinds()) {
      if (KIND_ADMISSION[kind] !== null) continue;
      expect(
        predicate,
        `kind '${kind}' is now admitted: update KIND_ADMISSION with the fragment that admits it`,
      ).not.toContain(`'${kind}'`);
    }
  });

  it("names every carried kind in the product_type projection, never leaving it to ELSE 'spot'", () => {
    // A launch rendered as a spot trade would state a route, a price and a
    // counterparty a token creation never had; `swap` is the one kind the ELSE
    // arm legitimately covers.
    for (const kind of liveKinds()) {
      if (kind === "swap" || KIND_ADMISSION[kind] === null) continue;
      expect(
        TOKEN_HISTORY_SRC,
        `kind '${kind}' falls through to ELSE 'spot' in the token history projection`,
      ).toContain(`WHEN '${kind}' THEN`);
    }
  });
});
