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
 * Distribution at 1B ship (140 protocol tools): 112 read, 17
 * user_wallet_broadcast, 11 external_post; 0 destructive,
 * approval_prepare, schedule, local_write.
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
  it("non-mutating protocol tools classify as 'read'", () => {
    // Reviewed exceptions: the Hypervexing workspace tools emit a UI-mode event
    // only — no approval, no capture, no provider call, no durable state. They
    // classify as 'local_write' (honest: they change local presentation state),
    // and stay non-mutating so the agent can switch the mode without friction.
    const reviewedLocalWrites = new Set([
      "hyperliquid.workspace.enter",
      "hyperliquid.workspace.exit",
      "hyperliquid.market.watchCandles",
    ]);
    const violations = PROTOCOL_TOOLS
      .filter((m) => !m.mutating && m.actionKind !== "read")
      .filter((m) => !(reviewedLocalWrites.has(m.toolId) && m.actionKind === "local_write"))
      .map((m) => `${m.toolId}: mutating=false but actionKind=${m.actionKind}`);
    expect(violations, "non-mutating tools mis-classified as something other than read").toEqual([]);
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

    // KyberSwap — split between on-chain wallet broadcasts and off-chain
    // limit-order relay submissions (gasless EIP-712).
    ["kyberswap.swap.sell", "user_wallet_broadcast"],
    ["kyberswap.swap.buy", "user_wallet_broadcast"],
    ["kyberswap.swap.quote", "read"],

    // Codex 1B Q2 ruling: `cancel` (soft, gasless lapse) is off-chain;
    // `hardCancel` / `cancelAll` are on-chain.
    ["kyberswap.limitOrder.create", "external_post"],
    ["kyberswap.limitOrder.cancel", "external_post"],
    ["kyberswap.limitOrder.hardCancel", "user_wallet_broadcast"],
    ["kyberswap.limitOrder.cancelAll", "user_wallet_broadcast"],
    ["kyberswap.limitOrder.fill", "user_wallet_broadcast"],
    ["kyberswap.limitOrder.batchFill", "user_wallet_broadcast"],

    // KyberSwap zap — all on-chain LP operations.
    ["kyberswap.zap.in", "user_wallet_broadcast"],
    ["kyberswap.zap.out", "user_wallet_broadcast"],
    ["kyberswap.zap.migrate", "user_wallet_broadcast"],
    ["kyberswap.zap.list", "read"],

    // Polymarket — Codex 1A Q3: EIP-712 CLOB orders are off-chain.
    // No `user_wallet_broadcast` in polymarket today (no direct chain settlement
    // exposed at this layer; bridge funding addresses are off-chain prep).
    ["polymarket.clob.buy", "external_post"],
    ["polymarket.clob.sell", "external_post"],
    ["polymarket.clob.cancel", "external_post"],
    ["polymarket.clob.cancelAll", "external_post"],
    ["polymarket.clob.cancelMarket", "external_post"],
    ["polymarket.clob.cancelOrders", "external_post"],
    ["polymarket.clob.heartbeat", "external_post"], // keep-alive signal
    ["polymarket.clob.orderbook", "read"],
    ["polymarket.bridge.deposit", "external_post"], // address prep, not settlement
    ["polymarket.bridge.withdraw", "external_post"],
    ["polymarket.bridge.assets", "read"],
    ["polymarket.gamma.events", "read"],
    ["polymarket.data.positions", "read"],
    ["polymarket.rewards.active", "read"],

    // Solana / Jupiter — all mutations are on-chain Solana program writes.
    // Codex 1B Q1 confirmed via handler inspection (executeJupiterPrediction*
    // + walletSecret()).
    ["solana.swap.execute", "user_wallet_broadcast"],
    ["solana.swap.quote", "read"],
    ["solana.lend.deposit", "user_wallet_broadcast"],
    ["solana.lend.withdraw", "user_wallet_broadcast"],
    ["solana.lend.rates", "read"],
    ["solana.predict.buy", "user_wallet_broadcast"],
    ["solana.predict.sell", "user_wallet_broadcast"],
    ["solana.predict.claim", "user_wallet_broadcast"],
    ["solana.predict.closeAll", "user_wallet_broadcast"],
    ["solana.predict.events", "read"],

    // Hyperliquid Bridge2 funding is a direct Arbitrum ERC-20 broadcast.
    ["hyperliquid.deposit", "user_wallet_broadcast"],

    // DexScreener — entirely read-only (no auth, no API key).
    ["dexscreener.search", "read"],
    ["dexscreener.tokens", "read"],
    ["dexscreener.trending", "read"],
  ];

  it.each(CRITICAL_MAPPINGS)("%s → %s", (toolId, expectedKind) => {
    const manifest = PROTOCOL_TOOLS.find((m) => m.toolId === toolId);
    expect(manifest, `manifest for ${toolId} should exist`).toBeDefined();
    expect(manifest!.actionKind, `${toolId} should classify as ${expectedKind}`).toBe(expectedKind);
  });
});
