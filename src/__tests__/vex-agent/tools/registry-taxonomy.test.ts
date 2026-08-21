/**
 * Action taxonomy — registry coverage + pinned classifications.
 *
 * Puzzle 5 phase 1A (2026-05-23): every internal `ToolDef.actionKind` must
 * be REQUIRED + declared at registration time. The compiler enforces the
 * field's presence on `ToolDef`; this suite enforces:
 *
 *  1. Every registered tool's `actionKind` is a member of `ACTION_KINDS`
 *     (no string drift between the type union and the runtime list).
 *  2. The list (`ACTION_KINDS`) and the union (`ActionKind`) cover the same
 *     7 values — `assertExhaustiveActionKind` would surface a missing branch
 *     at compile time; this test pins both directions.
 *  3. Critical mappings agreed in the puzzle 5/1A Codex review stay stable
 *     (regression guard for "someone reclassified WalletSendConfirm").
 *
 * The full per-tool mapping is in `src/vex-agent/tools/registry/*.ts`; this
 * test does NOT enumerate every tool because the type system already enforces
 * each new tool to declare `actionKind`. It pins ONLY the security/policy-
 * relevant decisions where a silent reclassification would change phase 2+
 * approval behavior.
 *
 * Phase 1B will add `actionKind` to `ProtocolToolManifest` and replace the
 * `deriveProtocolActionKind` heuristic in `protocols/runtime.ts` with a
 * direct field read — at that point a separate test file will pin per-protocol
 * mappings (e.g. polymarket.bridge → user_wallet_broadcast).
 */

import { describe, it, expect } from "vitest";
import { getAllTools, getActionKind } from "@vex-agent/tools/registry.js";
import { ACTION_KINDS, type ActionKind } from "@vex-agent/tools/taxonomy.js";

describe("ActionKind taxonomy — registry coverage", () => {
  it("every registered internal tool's actionKind is a member of ACTION_KINDS", () => {
    const validKinds = new Set<ActionKind>(ACTION_KINDS);
    const violations: string[] = [];

    for (const tool of getAllTools()) {
      if (!validKinds.has(tool.actionKind)) {
        violations.push(`${tool.name}: declares actionKind=${String(tool.actionKind)} not in ACTION_KINDS`);
      }
    }

    expect(violations, "tools with actionKind outside ACTION_KINDS").toEqual([]);
  });

  it("ACTION_KINDS array contains exactly the 7 documented variants", () => {
    // If the union is widened,
    // bump both the union AND this list — and update every consumer that
    // switches on ActionKind (the `assertExhaustiveActionKind` guard will
    // make the missing branches compile-fail before this test runs).
    expect([...ACTION_KINDS].sort()).toEqual([
      "approval_prepare",
      "destructive",
      "external_post",
      "local_write",
      "read",
      "schedule",
      "user_wallet_broadcast",
    ]);
    const removedRemoteSigningKind = ["provider", "action", "request"].join(
      "_",
    );
    expect(new Set<string>(ACTION_KINDS).has(removedRemoteSigningKind)).toBe(
      false,
    );
  });
});

describe("ActionKind — pinned critical classifications", () => {
  // Codex GREEN LIGHT 2026-05-23 — these mappings drive puzzle 5 phase 2+
  // approval / wallet / audit policy. A regression here would silently change
  // approval semantics, so each one is pinned explicitly.

  const CRITICAL_MAPPINGS: ReadonlyArray<readonly [string, ActionKind]> = [
    // Wallet — user signs locally
    ["WalletSendConfirm", "user_wallet_broadcast"],
    ["WalletSendPrepare", "approval_prepare"],
    ["WalletBalances", "read"],

    // Read-only DB / RPC / external API surfaces
    ["ChainRead", "read"],
    ["AgentScan", "read"],
    ["SessionMemorySearch", "read"],
    ["MemorySearch", "read"],
    ["MemoryGet", "read"],

    // External API calls — read-only per Codex bindings:
    // network egress / privacy is a separate dimension, not `external_post`.
    ["WebResearch", "read"],
    ["TwitterAccount", "read"],

    // Local writes — memory suggestions, mission draft, compaction
    ["MemorySuggest", "local_write"],
    ["MissionDraftUpdate", "local_write"],
    ["SessionMemoryResolve", "local_write"],
    ["CompactApply", "local_write"],

    // MissionStop is a state transition via engineSignal, not deferred work —
    // classify as local_write (Codex Q2 ruling, puzzle 5/1A).
    ["MissionStop", "local_write"],

    // Schedule — reserved for delayed / deferred execution (Codex Q2 ruling).
    ["LoopDefer", "schedule"],

    // Protocol meta-tools — wrapper is read; protocol target classification
    // is derived dynamically in `executeProtocolTool` (see execute-tool-taxonomy test).
    ["ToolSearch", "read"],

    // Khalani read-only alias
    ["TokenFind", "read"],
  ];

  it.each(CRITICAL_MAPPINGS)("%s → %s", (toolName, expectedKind) => {
    const actual = getActionKind(toolName);
    expect(actual, `${toolName} should classify as ${expectedKind}`).toBe(expectedKind);
  });

  it("getActionKind returns undefined for unregistered tool names", () => {
    expect(getActionKind("definitely-not-a-real-tool")).toBeUndefined();
  });
});
