/**
 * Protocol manifest action taxonomy — coverage + pinned critical mappings.
 *
 * Puzzle 5 phase 1B (2026-05-23). Every `ProtocolToolManifest.actionKind`
 * is REQUIRED at compile time (same invariant as `ToolDef.actionKind`).
 * This suite enforces the per-manifest classification at three levels:
 *
 *  1. **Coverage** — every registered protocol manifest declares an
 *     `actionKind` that is a member of `ACTION_KINDS`. (Type system already
 *     enforces presence; this catches accidental string drift if anyone
 *     bypasses the type via `as`.)
 *
 *  2. **Mutating ↔ taxonomy invariant** (Codex 1B GREEN LIGHT):
 *     non-mutating protocol tools MUST classify as `read`; mutating
 *     protocol tools MUST NOT classify as `read`. Catches accidental
 *     under-classification (e.g. someone marks a new swap tool
 *     `actionKind: "read"` by copy-paste).
 *
 *  3. **Pinned critical mappings** per namespace — security/policy-
 *     relevant decisions from the Codex 1B review stay stable. A silent
 *     reclassification would change phase 2+ approval semantics, so each
 *     critical tool is pinned explicitly.
 *
 * Protocol approval-prepare tools are allowed to be non-mutating even though
 * their action kind is not `read`: they create local preparation state for a
 * later human approval, not an external side effect.
 */

import { describe, it, expect } from "vitest";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { ACTION_KINDS, type ActionKind } from "@vex-agent/tools/taxonomy.js";

describe("ProtocolToolManifest taxonomy — coverage", () => {
  it("every registered protocol manifest's actionKind is a member of ACTION_KINDS", () => {
    const validKinds = new Set<ActionKind>(ACTION_KINDS);
    const violations: string[] = [];

    for (const manifest of PROTOCOL_TOOLS) {
      if (!validKinds.has(manifest.actionKind)) {
        violations.push(
          `${manifest.toolId}: declares actionKind=${String(manifest.actionKind)} not in ACTION_KINDS`,
        );
      }
    }

    expect(violations, "manifests with actionKind outside ACTION_KINDS").toEqual([]);
  });

  it("no protocol manifest leaks actionKind === undefined (defense-in-depth)", () => {
    // REQUIRED field at the type level, but pin at runtime in case anyone
    // bypasses the type via `as` or constructs a manifest dynamically.
    const undefinedKinds = PROTOCOL_TOOLS
      .filter((m) => m.actionKind === undefined)
      .map((m) => m.toolId);
    expect(undefinedKinds, "protocol manifests with undefined actionKind").toEqual([]);
  });
});

describe("ProtocolToolManifest taxonomy — mutating ↔ taxonomy invariant", () => {
  it("non-mutating protocol tools classify as 'read' unless they are approval preparation", () => {
    const violations = PROTOCOL_TOOLS
      .filter((m) => !m.mutating && m.actionKind !== "read" && m.actionKind !== "approval_prepare")
      .map((m) => `${m.toolId}: mutating=false but actionKind=${m.actionKind}`);
    expect(violations, "non-mutating tools mis-classified as something other than read/approval_prepare").toEqual([]);
  });

  it("mutating protocol tools do NOT classify as 'read'", () => {
    // The preview-override path in `executeProtocolTool` is a runtime
    // concept (preview returns `read` regardless of manifest), but the
    // MANIFEST itself for a mutating tool should never be `read`.
    const violations = PROTOCOL_TOOLS
      .filter((m) => m.mutating && m.actionKind === "read")
      .map((m) => `${m.toolId}: mutating=true but actionKind="read" — under-classified`);
    expect(violations, "mutating tools mis-classified as read").toEqual([]);
  });
});

describe("ProtocolToolManifest taxonomy — pinned critical mappings", () => {
  // Each per-namespace critical mapping captures a Codex 1B binding.
  // Regressions here surface as failed test ids, not silent semantic drift.

  const CRITICAL_MAPPINGS: ReadonlyArray<readonly [string, ActionKind]> = [
    // Khalani — cross-chain bridge is the only mutation; signs + broadcasts.
    ["khalani.bridge", "user_wallet_broadcast"],
    ["khalani.tokens.search", "read"],

    // KyberSwap — swap only (Agent Scan plan v3 §1.9/§4.2: limit orders and
    // zap deleted wholesale; buy/sell unified into one execute toolId).
    ["kyberswap.swap.execute", "user_wallet_broadcast"],
    ["kyberswap.swap.quote", "read"],

    // Solana / Jupiter — all mutations are on-chain Solana program writes.
    // Codex 1B Q1 confirmed via handler inspection (executeJupiterPrediction*
    // + walletSecret()).
    ["solana.swap.execute", "user_wallet_broadcast"],
    ["solana.swap.quote", "read"],
    ["solana.lend.deposit", "user_wallet_broadcast"],
    ["solana.lend.withdraw", "user_wallet_broadcast"],
    ["solana.lend.rates", "read"],
    // Batch 5 (card B1) — Jupiter Lend Borrow.
    ["solana.lend.borrowOperate", "user_wallet_broadcast"],
    ["solana.lend.borrowVaults", "read"],
    ["solana.lend.borrowPositions", "read"],
    ["solana.predict.buy", "user_wallet_broadcast"],
    ["solana.predict.sell", "user_wallet_broadcast"],
    ["solana.predict.claim", "user_wallet_broadcast"],
    ["solana.predict.closeAll", "user_wallet_broadcast"],
    ["solana.predict.events", "read"],

    // DexScreener — entirely read-only (no auth, no API key).
    ["dexscreener.search", "read"],
    ["dexscreener.tokens", "read"],
    ["dexscreener.trending", "read"],

    // Lighter — create.prepare records local approval intent state; create is
    // the external exchange mutation resume target.
    ["lighter.order.create.prepare", "approval_prepare"],
    ["lighter.order.create", "external_post"],
  ];

  it.each(CRITICAL_MAPPINGS)("%s → %s", (toolId, expectedKind) => {
    const manifest = PROTOCOL_TOOLS.find((m) => m.toolId === toolId);
    expect(manifest, `manifest for ${toolId} should exist`).toBeDefined();
    expect(manifest!.actionKind, `${toolId} should classify as ${expectedKind}`).toBe(expectedKind);
  });
});
