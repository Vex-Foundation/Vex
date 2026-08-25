/**
 * G2(b) - the internal-tool description lint.
 *
 * Coverage, exactly:
 *
 *   rule `tool-description` (protocols/manifest-lint.test.ts): the 134
 *       protocol manifests plus 14 internal tools (action-alias + wallet).
 *       Unchanged by this suite.
 *   rule `internal-tool-description` (here): ALL 32 registered internal
 *       `ToolDef`s, the 14 included.
 *
 * (The 137/34 this comment claimed were stale by the ToolSearch merge; the
 * live figures are asserted below, and 14 is still correct.)
 *
 * The ActionKind lane deliberately overlaps the older rule. The tools with the
 * strongest obligations - `BridgeExecute`, `SwapExecute`, `WalletSendPrepare`,
 * `WalletSendConfirm` - are inside those 14, and the older rule cannot
 * demand an approval statement from them because it reads `mutating`, not the
 * action taxonomy. Two rule ids means a tool linted by both reports and
 * allowlists each finding separately, with no double-report ambiguity.
 *
 * Requirements are ActionKind-specific: `mutating` alone does not mean "spends
 * funds" on this lane (see `internal-description-rules.ts`).
 */

import { describe, it, expect } from "vitest";

import { getAllTools } from "@vex-agent/tools/registry.js";
import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";
import { WALLET_TOOLS } from "@vex-agent/tools/registry/wallet.js";
import { WALLET_TRANSACTION_TOOLS } from "@vex-agent/tools/registry/wallet-transaction.js";
import { ACTION_KINDS } from "@vex-agent/tools/taxonomy.js";
import { lintInternalToolDescription } from "@vex-agent/tools/protocols/_manifest-lint/internal-description-rules.js";
import {
  INTERNAL_DESCRIPTION_ALLOWLIST,
  staleInternalAllowlistKeys,
  withoutInternalAllowlisted,
} from "@vex-agent/tools/protocols/_manifest-lint/internal-description-allowlist.js";
import type { ManifestLintIssue } from "@vex-agent/tools/protocols/_manifest-lint.js";

/**
 * Tools the older `tool-description` rule already sees, derived from the very
 * arrays that suite lints rather than from a hand-copied name list. Used only
 * to assert the split honestly; it does NOT narrow this lane.
 */
const BASIC_LANE = new Set(
  [...ACTION_ALIAS_TOOLS, ...WALLET_TOOLS, ...WALLET_TRANSACTION_TOOLS].map((tool) => tool.name),
);

/** Every registered internal tool. The ActionKind lane excludes nothing. */
const SUBJECTS = getAllTools();

const issues = SUBJECTS.flatMap((tool) =>
  lintInternalToolDescription({
    name: tool.name,
    description: tool.description,
    actionKind: tool.actionKind,
  }),
);

function format(list: readonly ManifestLintIssue[]): string {
  return list.map((i) => `  - ${i.subject} [${i.rule}/${i.detail}] ${i.message}`).join("\n");
}

describe("G2 - internal tool description lint", () => {
  it("lints every registered internal tool, including the 14 the basic rule sees", () => {
    // 34 → 32: the ToolSearch merge deleted the `describe_tools` and
    // `execute_tool` ToolDefs (`registry/protocol.ts`).
    // 32 → 36: stage A4b registered the four generic transaction signing tools,
    // all four inside the basic (JSON-schema) lane, which is why that count
    // moved from 14 to 18 in the same step.
    // 36 → 37: `BoardCompose` (`registry/board.ts`), outside the basic lane.
    expect(SUBJECTS).toHaveLength(37);
    expect(BASIC_LANE.size, "basic-lane coverage changed").toBe(18);

    // The 19 the basic rule never saw (18 + `BoardCompose`), and the 14 it
    // sees without an ActionKind, are ALL in this lane.
    const linted = new Set(SUBJECTS.map((tool) => tool.name));
    for (const name of BASIC_LANE) {
      expect(linted.has(name), `${name} is outside the ActionKind lane`).toBe(true);
    }
    expect([...linted].filter((name) => !BASIC_LANE.has(name))).toHaveLength(19);
  });

  // The blast radius of the split: without the overlap, no committed rule can
  // state that a fund-moving tool must name its approval step.
  it("subjects every money-path internal tool to the ActionKind obligations", () => {
    const moneyPath = SUBJECTS.filter(
      (tool) => tool.actionKind === "user_wallet_broadcast" || tool.actionKind === "approval_prepare",
    ).map((tool) => tool.name);

    expect(moneyPath).toEqual(expect.arrayContaining([
      "BridgeExecute", "SwapExecute", "SwapExecuteUniswap", "BridgeExecuteRelay",
      "WalletSendPrepare", "WalletSendConfirm",
      "WalletEvmTransactionPrepare", "WalletEvmTransactionConfirm",
      "WalletSolanaTransactionPrepare", "WalletSolanaTransactionConfirm",
    ]));
    // Every one of them sits in the basic lane too, which is exactly why the
    // ActionKind lane may not exclude that lane.
    expect(moneyPath.filter((name) => !BASIC_LANE.has(name))).toEqual([]);
  });

  // CONTRACT CHANGE (internal-description rewrite wave). This test previously
  // asserted the INVERSE: that `BridgeExecute`'s missing approval sentence was
  // still detected, and still allowlisted. That was right while the gap was
  // recorded debt and is wrong now that it is fixed - a test pinning a
  // money-path defect in place outlives its purpose the moment the defect is
  // paid off. It now asserts what the wave delivered: the
  // `user_wallet_broadcast` that moves funds across chains NAMES the human
  // decision gating it, with nothing left excusing it.
  it("bridge names the approval that gates its broadcast", () => {
    const bridge = SUBJECTS.find((tool) => tool.name === "BridgeExecute");
    expect(bridge?.actionKind).toBe("user_wallet_broadcast");

    const found = issues.filter((i) => i.subject === "BridgeExecute" && i.detail === "approval");
    expect(found, "bridge's approval statement regressed").toEqual([]);
    expect(
      INTERNAL_DESCRIPTION_ALLOWLIST.filter((e) => e.subject === "BridgeExecute"),
      "bridge may not be excused by an allowlist entry again",
    ).toEqual([]);
  });

  // The same wave paid off the whole lane, so the table is empty and may only
  // stay that way: with no rows, a NEW violation on any of the 32 tools fails
  // immediately rather than being admissible as recorded debt.
  it("the internal-description allowlist is empty and may only stay empty", () => {
    expect(INTERNAL_DESCRIPTION_ALLOWLIST).toEqual([]);
  });

  it("no internal tool description violates the rules outside the allowlist", () => {
    const live = withoutInternalAllowlisted(issues);
    expect(live, `unallowlisted internal description violations:\n${format(live)}`).toEqual([]);
  });

  it("the allowlist carries no stale entry (a fixed description must delete its line)", () => {
    const stale = staleInternalAllowlistKeys(issues);
    expect(
      stale,
      `these entries no longer match a live violation - delete them:\n${stale.map((k) => `  - ${k}`).join("\n")}`,
    ).toEqual([]);
  });

  it("the allowlist is the measured debt of this lane and nothing else", () => {
    // Every entry names a tool this suite actually lints. An entry for a tool
    // the other suite owns would silently excuse nothing.
    const subjectNames = new Set(SUBJECTS.map((tool) => tool.name));
    const foreign = INTERNAL_DESCRIPTION_ALLOWLIST
      .filter((entry) => !subjectNames.has(entry.subject))
      .map((entry) => entry.subject);
    expect(foreign, "allowlist entries for tools this suite does not lint").toEqual([]);
    expect(INTERNAL_DESCRIPTION_ALLOWLIST.every((e) => e.rule === "internal-tool-description")).toBe(true);
  });
});

// ── Rule behavior, proven against synthetic ToolDefs ──────────────

const COMPLIANT_READ =
  "Use this when the user asks which markets are open on a venue and you already know the venue slug. "
  + "Returns a JSON object with a `summary` string and a `markets` array of market ids and labels.";

const COMPLIANT_BROADCAST =
  "Use this when the user has already chosen a route and wants it executed. SPENDS real funds: this "
  + "broadcasts an on-chain transaction from the user wallet, and it requires explicit user approval "
  + "before it is sent. Returns the transaction hash and the submitted route.";

describe("G2 - internal description rules by ActionKind", () => {
  it("accepts a compliant read description", () => {
    expect(lintInternalToolDescription({
      name: "demo_read", description: COMPLIANT_READ, actionKind: "read",
    })).toEqual([]);
  });

  it("accepts a compliant user_wallet_broadcast description", () => {
    expect(lintInternalToolDescription({
      name: "demo_send", description: COMPLIANT_BROADCAST, actionKind: "user_wallet_broadcast",
    })).toEqual([]);
  });

  it("fails a NEW violation immediately: a short description with no anchors", () => {
    const found = lintInternalToolDescription({
      name: "demo_new", description: "Does a thing.", actionKind: "read",
    });
    expect(found.map((i) => i.detail).sort()).toEqual(["length", "returns", "when-to-use"]);
    expect(withoutInternalAllowlisted(found)).toEqual(found);
  });

  it("requires SPENDS and approval on user_wallet_broadcast", () => {
    const found = lintInternalToolDescription({
      name: "demo_send", description: COMPLIANT_READ, actionKind: "user_wallet_broadcast",
    });
    expect(found.map((i) => i.detail).sort()).toEqual(["approval", "spends"]);
  });

  it("requires approval flow on approval_prepare, but not SPENDS", () => {
    const found = lintInternalToolDescription({
      name: "demo_prepare", description: COMPLIANT_READ, actionKind: "approval_prepare",
    });
    expect(found.map((i) => i.detail)).toEqual(["approval"]);
  });

  it("does not force SPENDS on local_write or schedule", () => {
    for (const actionKind of ["local_write", "schedule"] as const) {
      const found = lintInternalToolDescription({
        name: `demo_${actionKind}`, description: COMPLIANT_READ, actionKind,
      });
      expect(found, `${actionKind} must not require a spends statement`).toEqual([]);
    }
  });

  // The deliberate cases named in the plan: a non-read actionKind with
  // `mutating: false`. Classifying by the boolean would have demanded a SPENDS
  // sentence from a tool that moves no funds.
  it.each(["WalletTrackToken", "MemorySuggest", "MissionDraftUpdate"])(
    "does not demand a spends statement from %s",
    (name) => {
      const tool = getAllTools().find((t) => t.name === name);
      expect(tool, `${name} is no longer registered`).toBeDefined();
      expect(tool?.mutating).toBe(false);
      const found = lintInternalToolDescription({
        name, description: tool!.description, actionKind: tool!.actionKind,
      });
      expect(found.filter((i) => i.detail === "spends")).toEqual([]);
    },
  );

  it("classifies every declared ActionKind without throwing", () => {
    for (const actionKind of ACTION_KINDS) {
      expect(() => lintInternalToolDescription({
        name: "demo", description: COMPLIANT_BROADCAST, actionKind,
      })).not.toThrow();
    }
  });
});
