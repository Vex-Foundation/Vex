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
 *     (regression guard for "someone reclassified wallet_send_confirm").
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
    ["wallet_send_confirm", "user_wallet_broadcast"],
    ["wallet_send_prepare", "approval_prepare"],
    ["wallet_balances", "read"],

    // Read-only DB / RPC / external API surfaces
    ["chain_read", "read"],
    ["agent_scan", "read"],
    ["session_memory_search", "read"],
    ["long_memory_search", "read"],
    ["long_memory_get", "read"],

    // External API calls — read-only per Codex bindings:
    // network egress / privacy is a separate dimension, not `external_post`.
    ["web_research", "read"],
    ["twitter_account", "read"],

    // Local writes — memory suggestions, mission draft, compaction
    ["long_memory_suggest", "local_write"],
    ["mission_draft_update", "local_write"],
    ["session_memory_resolve_item", "local_write"],
    ["compact_apply", "local_write"],

    // mission_stop is a state transition via engineSignal, not deferred work —
    // classify as local_write (Codex Q2 ruling, puzzle 5/1A).
    ["mission_stop", "local_write"],

    // Schedule — reserved for delayed / deferred execution (Codex Q2 ruling).
    ["loop_defer", "schedule"],

    // Protocol meta-tools — wrapper is read; protocol target classification
    // is derived dynamically in `executeProtocolTool` (see execute-tool-taxonomy test).
    ["discover_tools", "read"],
    ["execute_tool", "read"],

    // Khalani read-only aliases
    ["khalani_chains_list", "read"],
    ["khalani_tokens_top", "read"],
    ["token_find", "read"],
    ["khalani_tokens_balances", "read"],
  ];

  it.each(CRITICAL_MAPPINGS)("%s → %s", (toolName, expectedKind) => {
    const actual = getActionKind(toolName);
    expect(actual, `${toolName} should classify as ${expectedKind}`).toBe(expectedKind);
  });

  it("getActionKind returns undefined for unregistered tool names", () => {
    expect(getActionKind("definitely-not-a-real-tool")).toBeUndefined();
  });
});
