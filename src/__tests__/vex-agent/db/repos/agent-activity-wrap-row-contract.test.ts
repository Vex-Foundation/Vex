/**
 * The `kind = 'wrap'` activity row's own contract, on the two surfaces that
 * decide what a wrap row may BE: the SQL kind/role binding, and
 * `roleLegsIncomplete`.
 *
 * WHY BOTH, AND WHY HERE. The wrap lane's claim writer creates a row with
 * `kind: "wrap"` and `eventRole` equal to the intent's direction, carrying BOTH
 * legs. Two independent things have to agree with that, and neither is provable
 * from the writer:
 *
 *  1. THE DATABASE must admit exactly `wrap` and `unwrap` under that kind, and
 *     must admit NO FEE ROLE. Migration 096's header states the absence of a
 *     fee as a design decision enforced in three places, and this binding is
 *     one of them: with no `*_fee` role permitted on the kind, a fee leg beside
 *     a wrap is not a policy a branch can relax, it is a row Postgres rejects.
 *     The constraint body is parsed out of the migrations AS WRITTEN and run
 *     through the repo suite's SQL check evaluator, so this answers "would
 *     Postgres accept this row?" rather than "does a substring appear?".
 *  2. `roleLegsIncomplete` must place both roles on the BOTH-LEGS arm. Three
 *     callers ask it - the strict confirm guard, the late-fill CAS and the
 *     settlement-decline writer - and the wrap settlement's whole anomaly
 *     branch exists because of the answer: a `confirmed` wrap row with a
 *     missing executed leg has to stay a correction candidate rather than be
 *     treated as finished.
 *
 * The row's LEG CONTENT (native sentinel, bound contract, order per direction)
 * is proven against the real written row in
 * `src/__tests__/integration/repos/wallet-wrap-terminal-settlement.int.test.ts`,
 * because the writer composes it inside the claim transaction.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";

import {
  roleLegsIncomplete,
  isAmountBearingRole,
} from "@vex-agent/db/repos/agent-activity/role-legs.js";
import type { RoleLegRow } from "@vex-agent/db/repos/agent-activity/role-legs.js";
import type { AgentActivityEventRole } from "@vex-agent/db/repos/agent-activity/types.js";

import { evaluateSqlCheck, extractCheckBody, type SqlRow } from "./_sql-check-eval.js";

const MIGRATIONS_DIR = join(getPackageRoot(), "src", "vex-agent", "db", "migrations");

/**
 * Every migration in application order, concatenated. `extractCheckBody` takes
 * the LAST definition of a constraint, which is the live one: 051 introduced
 * the wrap arm and 088 re-added the whole binding around it.
 */
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf-8"))
  .join("\n");

/** The evaluator has no comment token, so `--` tails are removed first. */
function withoutComments(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

const KIND_ROLE_BINDING = withoutComments(
  extractCheckBody(MIGRATION_SQL, "agent_activity_kind_role_binding"),
);

function bindingRow(kind: string, eventRole: string): SqlRow {
  return { kind, event_role: eventRole };
}

describe("the kind/role binding admits exactly the two wrap roles", () => {
  for (const role of ["wrap", "unwrap"] as const) {
    it(`accepts kind='wrap' with event_role='${role}'`, () => {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow("wrap", role))).toBe(true);
    });
  }

  const foreign = [
    "swap",
    "allowance",
    "allowance_reset",
    "bridge_deposit",
    "lend_deposit",
    "token_launch",
    "wallet_transfer",
    "tx_contract_call",
  ] as const;

  for (const role of foreign) {
    it(`rejects kind='wrap' with event_role='${role}'`, () => {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow("wrap", role))).toBe(false);
    });
  }

  it("rejects the two wrap roles under every OTHER kind", () => {
    for (const kind of ["swap", "bridge", "lend", "prediction", "yield", "launch", "transaction"]) {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow(kind, "wrap"))).toBe(false);
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow(kind, "unwrap"))).toBe(false);
    }
  });
});

describe("a wrap row can carry NO fee leg, by database construction", () => {
  /**
   * Every fee role the binding grants to any kind. A wrap must pair with none
   * of them: there is no fee parameter in the claim writer's signature, and
   * this is the durable half of that same statement.
   */
  const FEE_ROLES = [
    "swap_fee",
    "trench_fee",
    "bridge_fee",
    "pools_fee",
    "tx_vex_fee",
  ] as const;

  for (const role of FEE_ROLES) {
    it(`kind='wrap' with event_role='${role}' is not a row Postgres accepts`, () => {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow("wrap", role))).toBe(false);
    });
  }

  it("each fee role is a REAL role somewhere, so these are not typos passing vacuously", () => {
    // Without this, a renamed fee role would make every assertion above pass
    // for the wrong reason: an unknown literal is rejected by every arm.
    const owners: Record<(typeof FEE_ROLES)[number], string> = {
      swap_fee: "swap",
      trench_fee: "swap",
      bridge_fee: "bridge",
      pools_fee: "launch",
      tx_vex_fee: "transaction",
    };
    for (const [role, kind] of Object.entries(owners)) {
      expect(evaluateSqlCheck(KIND_ROLE_BINDING, bindingRow(kind, role))).toBe(true);
    }
  });
});

// ── roleLegsIncomplete ────────────────────────────────────────────────

const EMPTY: Omit<RoleLegRow, "eventRole"> = {
  executedAmountInRaw: null,
  executedAmountOutRaw: null,
  executedAmountIn2Raw: null,
  executedAmountOut2Raw: null,
  tokenInAddress: null,
  tokenOutAddress: null,
  tokenIn2Address: null,
  tokenOut2Address: null,
};

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const WETH = "0x4200000000000000000000000000000000000006";
const AMOUNT = "2500000000000000000";

/** A wrap row as the claim writer creates it: both token legs, no executed legs yet. */
function wrapLegRow(
  eventRole: AgentActivityEventRole,
  fields: Partial<RoleLegRow> = {},
): RoleLegRow {
  const wrapping = eventRole === "wrap";
  return {
    ...EMPTY,
    eventRole,
    tokenInAddress: wrapping ? NATIVE_SENTINEL : WETH,
    tokenOutAddress: wrapping ? WETH : NATIVE_SENTINEL,
    ...fields,
  };
}

describe("roleLegsIncomplete - a wrap row owes BOTH executed legs", () => {
  for (const role of ["wrap", "unwrap"] as const) {
    it(`${role} is amount-bearing and incomplete until both legs exist`, () => {
      expect(isAmountBearingRole(role)).toBe(true);

      // The state the settlement's anomaly branch produces: confirmed, hash
      // held, and no executed amount. It must read INCOMPLETE, or the
      // correction lane has no candidate and the row is silently final.
      expect(roleLegsIncomplete(wrapLegRow(role))).toBe(true);
      expect(roleLegsIncomplete(wrapLegRow(role, { executedAmountInRaw: AMOUNT }))).toBe(true);
      expect(roleLegsIncomplete(wrapLegRow(role, { executedAmountOutRaw: AMOUNT }))).toBe(true);

      // Both proven: the decoder returns one quantity twice, and that is the
      // shape that completes the row.
      expect(
        roleLegsIncomplete(
          wrapLegRow(role, { executedAmountInRaw: AMOUNT, executedAmountOutRaw: AMOUNT }),
        ),
      ).toBe(false);
    });
  }

  it("completeness does not depend on the two legs being EQUAL", () => {
    // Migration 051's header is explicit: the relationship is 1:1 on EVM but
    // out-exceeds-in on a Solana unwrap-all, so the predicate proves PRESENCE
    // only. A future tightening to equality would refuse every honest Solana
    // unwrap, and this pins the decision rather than the current arithmetic.
    expect(
      roleLegsIncomplete(
        wrapLegRow("unwrap", {
          executedAmountInRaw: AMOUNT,
          executedAmountOutRaw: "2502039280000000000",
        }),
      ),
    ).toBe(false);
  });

  it("a wrap row never carries a second leg, and one would not make it complete", () => {
    // The second-leg columns belong to the paired yield roles. Filling them on
    // a wrap must not substitute for the first legs it actually owes.
    expect(
      roleLegsIncomplete(
        wrapLegRow("wrap", {
          executedAmountIn2Raw: AMOUNT,
          executedAmountOut2Raw: AMOUNT,
        }),
      ),
    ).toBe(true);
  });
});
