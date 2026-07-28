/**
 * transactions failure classifier — Stage 9 unit tests (Agent Scan plan §4.3
 * simplified the matrix: no more limitOrder/zap/polymarket rows, and the
 * KyberSwap/Uniswap swap executes are unified — no more buy/sell split. FIX-
 * SPINE round 1, finding 1/2/16/C9, added the static `LEGACY_TOOL_PRODUCTS`
 * map so a historical failed attempt for a DELETED tool still surfaces in
 * the feed instead of silently vanishing once its matrix row was removed).
 *
 * Pins:
 *   - the allowlist is derived from MUTATION_MATRIX.expectedType → TYPE_TO_PRODUCT
 *     (LIVE tools) PLUS the static LEGACY_TOOL_PRODUCTS map (DELETED tools),
 *     and contains ONLY trade-impacting tools (product ∈ {spot,perps,prediction,
 *     bridge,order} for live tools, +{lp} for legacy-only history).
 *   - non-trade LIVE mutating tools (stake/utility) are EXCLUDED; `lend`
 *     (Phase 3/W5) and Pendle's `yield` mutations (Batch B card B2, migration
 *     053 — PT/YT/PY, LP add/remove, reward claim) DO surface here.
 *   - read tools are never present (they are not in MUTATION_MATRIX at all).
 *   - EVERY deleted Agent Scan tool (old buy/sell split, limitOrder, zap,
 *     Polymarket trade tools) DOES reappear via the legacy map.
 *   - the productType-scoped allowlist filters by DERIVED PRODUCT.
 */

import { describe, it, expect } from "vitest";
import {
  FAILURE_TOOL_ALLOWLIST,
  FAILURE_TOOL_PRODUCTS,
  TRANSACTION_PRODUCTS,
  LEGACY_TRANSACTION_PRODUCTS,
  LEGACY_TOOL_PRODUCTS,
  failureToolsForProduct,
} from "@vex-agent/db/repos/transactions-failure-tools.js";

describe("transactions failure classifier", () => {
  it("every allowlisted tool maps to a transaction product (live products, or lp for legacy history)", () => {
    for (const toolId of FAILURE_TOOL_ALLOWLIST) {
      const product = FAILURE_TOOL_PRODUCTS.get(toolId);
      expect(product, `${toolId} has no product`).toBeDefined();
      expect(LEGACY_TRANSACTION_PRODUCTS.has(product!), `${toolId} → ${product} not a tx product`).toBe(true);
    }
  });

  it("every LEGACY_TOOL_PRODUCTS entry maps to a recognized product", () => {
    for (const [toolId, product] of LEGACY_TOOL_PRODUCTS) {
      expect(LEGACY_TRANSACTION_PRODUCTS.has(product), `${toolId} → ${product} not recognized`).toBe(true);
    }
  });

  it("includes trade-impacting tools across spot/perps + prediction + bridge + lend", () => {
    // Spot (swaps) — Jupiter (untouched) + the two Agent Scan unified executes.
    // KyberSwap/Uniswap failures are ALSO visible via this legacy half for the
    // (rare) case a failure happens before any agent_activity row could be
    // created (e.g. a thrown handler error pre-intent) — the compatibility
    // feed dedupes by protocol_execution_id, agent_activity wins.
    expect(FAILURE_TOOL_PRODUCTS.get("solana.swap.execute")).toBe("spot");
    expect(FAILURE_TOOL_PRODUCTS.get("kyberswap.swap.execute")).toBe("spot");
    expect(FAILURE_TOOL_PRODUCTS.get("uniswap.swap.execute")).toBe("spot");
    // Perps
    expect(FAILURE_TOOL_PRODUCTS.get("hyperliquid.perp.open")).toBe("perps");
    // Prediction
    expect(FAILURE_TOOL_PRODUCTS.get("solana.predict.buy")).toBe("prediction");
    // Bridge
    expect(FAILURE_TOOL_PRODUCTS.get("khalani.bridge")).toBe("bridge");
    // Lend (Agent Scan Phase 3/W5, migration 049)
    expect(FAILURE_TOOL_PRODUCTS.get("solana.lend.deposit")).toBe("lend");
    expect(FAILURE_TOOL_PRODUCTS.get("solana.lend.withdraw")).toBe("lend");
  });

  it("excludes utility tools but INCLUDES lend (Phase 3/W5) and Pendle's yield mutations (Batch B)", () => {
    // lend was added to TRANSACTION_PRODUCTS (migration 049, W5) — Jupiter
    // Lend deposit/withdraw are real wallet-impacting mutations with the same
    // pending/confirmed/definitively_failed lifecycle as swaps.
    expect(FAILURE_TOOL_PRODUCTS.get("solana.lend.deposit")).toBe("lend");
    expect(FAILURE_TOOL_PRODUCTS.get("solana.lend.withdraw")).toBe("lend");
    // Pendle LP is NO LONGER excluded — Batch B card B2 gave every Pendle
    // mutation the `yield` product (migration 053).
    expect(FAILURE_TOOL_PRODUCTS.get("pendle.lp.add")).toBe("yield");
    // utility → "social" (not in TYPE_TO_PRODUCT as a tx product)
    expect(FAILURE_TOOL_PRODUCTS.has("hyperliquid.risk.proposeSetup")).toBe(false);
  });

  it("excludes read tools entirely (never in the matrix → never in the allowlist)", () => {
    expect(FAILURE_TOOL_PRODUCTS.has("wallet_balances")).toBe(false);
    expect(FAILURE_TOOL_PRODUCTS.has("portfolio")).toBe(false);
    expect(FAILURE_TOOL_PRODUCTS.has("kyberswap.swap.quote")).toBe(false);
  });

  it("every deleted (Agent Scan) trade tool's HISTORY still surfaces via the legacy map (finding 1/2/16/C9)", () => {
    expect(FAILURE_TOOL_PRODUCTS.get("kyberswap.swap.buy")).toBe("spot");
    expect(FAILURE_TOOL_PRODUCTS.get("kyberswap.swap.sell")).toBe("spot");
    expect(FAILURE_TOOL_PRODUCTS.get("uniswap.swap.buy")).toBe("spot");
    expect(FAILURE_TOOL_PRODUCTS.get("uniswap.swap.sell")).toBe("spot");
    expect(FAILURE_TOOL_PRODUCTS.get("kyberswap.limitOrder.create")).toBe("order");
    expect(FAILURE_TOOL_PRODUCTS.get("kyberswap.zap.in")).toBe("lp");
    expect(FAILURE_TOOL_PRODUCTS.get("polymarket.clob.buy")).toBe("prediction");
    expect(FAILURE_TOOL_PRODUCTS.get("polymarket.clob.cancel")).toBe("order");
  });

  it("Hyperliquid trade tools' HISTORY is preserved in the legacy map ahead of Agent Scan Phase 3's deletion", () => {
    // These entries are added to LEGACY_TOOL_PRODUCTS BEFORE the live
    // MUTATION_MATRIX rows are removed (cross-card sequencing), so today the
    // LIVE derivation still wins (identical product) — this pins the value
    // that must keep holding once the live rows are gone.
    for (const [toolId, product] of [
      ["hyperliquid.spot.trade", "spot"],
      ["hyperliquid.perp.open", "perps"],
      ["hyperliquid.perp.close", "perps"],
      ["hyperliquid.perp.setTpsl", "perps"],
      ["hyperliquid.perp.modifyOrder", "perps"],
      ["hyperliquid.perp.cancelOrders", "perps"],
      ["hyperliquid.perp.setLeverage", "perps"],
      ["hyperliquid.perp.adjustMargin", "perps"],
      ["hyperliquid.perp.twap", "perps"],
    ] as const) {
      expect(FAILURE_TOOL_PRODUCTS.get(toolId)).toBe(product);
      expect(LEGACY_TOOL_PRODUCTS.get(toolId)).toBe(product);
    }
    // Non-trade Hyperliquid mutations (audit-only) and the utility risk-setup
    // tool never qualified for this feed — no legacy entry, same as
    // polymarket.clob.heartbeat and solana.lend.deposit above.
    expect(LEGACY_TOOL_PRODUCTS.has("hyperliquid.risk.proposeSetup")).toBe(false);
    expect(LEGACY_TOOL_PRODUCTS.has("hyperliquid.deposit")).toBe(false);
    expect(LEGACY_TOOL_PRODUCTS.has("hyperliquid.withdraw")).toBe(false);
    expect(LEGACY_TOOL_PRODUCTS.has("hyperliquid.vault.transfer")).toBe(false);
    expect(LEGACY_TOOL_PRODUCTS.has("hyperliquid.staking.delegate")).toBe(false);
    expect(LEGACY_TOOL_PRODUCTS.has("hyperliquid.rewards.claim")).toBe(false);
    expect(LEGACY_TOOL_PRODUCTS.has("hyperliquid.builder.approveFee")).toBe(false);
  });

  it("a deleted UTILITY tool (never trade-impacting) does NOT reappear — the legacy map is trade-only", () => {
    // polymarket.clob.heartbeat was "utility" (no product), not a trade tool —
    // deletion doesn't need a legacy entry for it, unlike the trade tools above.
    expect(FAILURE_TOOL_PRODUCTS.has("polymarket.clob.heartbeat")).toBe(false);
  });

  it("Pendle's LIVE mutations surface under 'yield', not under the legacy-only 'lp' product", () => {
    // Batch B card B2 (migration 053): every Pendle mutation — PT/YT/PY, LP
    // add/remove and the reward claim — records as `kind: 'yield'` in
    // agent_activity, so a FAILED attempt must reach the failure half too.
    // Their matrix `expectedType: "yield"` is intentionally absent from
    // TYPE_TO_PRODUCT, so LEGACY_TOOL_PRODUCTS is their product authority.
    for (const toolId of [
      "pendle.pt.buy", "pendle.pt.sell", "pendle.pt.redeem",
      "pendle.yt.buy", "pendle.yt.sell",
      "pendle.py.mint", "pendle.py.redeem",
      "pendle.lp.add", "pendle.lp.remove", "pendle.claim",
    ]) {
      expect(FAILURE_TOOL_PRODUCTS.get(toolId), toolId).toBe("yield");
      expect(LEGACY_TOOL_PRODUCTS.get(toolId), toolId).toBe("yield");
    }
    // "lp" itself is still legacy-only (the deleted zap tools' history).
    expect(TRANSACTION_PRODUCTS.has("lp")).toBe(false);
    expect(TRANSACTION_PRODUCTS.has("yield")).toBe(true);
  });

  it("failureToolsForProduct(undefined) returns the full allowlist", () => {
    expect(failureToolsForProduct()).toEqual(FAILURE_TOOL_ALLOWLIST);
  });

  it("failureToolsForProduct(product) intersects to tools whose derived product matches", () => {
    const spotTools = failureToolsForProduct("spot");
    expect(spotTools.length).toBeGreaterThan(0);
    for (const toolId of spotTools) {
      expect(FAILURE_TOOL_PRODUCTS.get(toolId)).toBe("spot");
    }
    expect(spotTools).toContain("solana.swap.execute");
    expect(spotTools).not.toContain("khalani.bridge");
  });

  it("failureToolsForProduct(unknown) returns an empty list (failure half matches nothing)", () => {
    expect(failureToolsForProduct("definitely-not-a-product")).toEqual([]);
    expect(failureToolsForProduct("stake")).toEqual([]); // stake is excluded from the allowlist
  });

  it("failureToolsForProduct('lend') intersects to the lend tools (Agent Scan Phase 3/W5)", () => {
    const lendTools = failureToolsForProduct("lend");
    expect(lendTools).toContain("solana.lend.deposit");
    expect(lendTools).toContain("solana.lend.withdraw");
    for (const toolId of lendTools) {
      expect(FAILURE_TOOL_PRODUCTS.get(toolId)).toBe("lend");
    }
  });
});
