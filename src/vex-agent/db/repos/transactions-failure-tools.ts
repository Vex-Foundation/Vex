/**
 * Transactions-view failure classifier (Stage 9; FIX-SPINE round 1 added the
 * static legacy-tool map per Codex finding 1/2/16, C9).
 *
 * The `transactions` view's FAILURE half surfaces FAILED trade-impacting
 * mutation attempts (protocol_executions WHERE success = false). Not every
 * mutating tool is trade-impacting — only the ones whose canonical product is a
 * transaction product belong in the feed. This module derives, ONCE at load,
 * the allowlist of `tool_id`s that qualify, plus a `tool_id → product` map for
 * the productType filter on the failure half.
 *
 * Single source of truth (reused, not duplicated):
 *   - `MUTATION_MATRIX` (tools/protocols/mutation-matrix.ts) — every CURRENT
 *     mutating tool's contract, incl. `expectedType` (string | string[]).
 *   - `TYPE_TO_PRODUCT` (sync/activity-populator.ts) — the same capture-type →
 *     product mapping the projector uses, so the failure half's derived product
 *     matches what the success half stores in proj_activity.product_type.
 *   - `LEGACY_TOOL_PRODUCTS` — a static, hand-maintained map for tools DELETED
 *     from the live matrix by Agent Scan (limitOrder, zap, the old kyber/
 *     uniswap buy/sell split, Polymarket, Hyperliquid trade tools — Phase 3
 *     total removal). Without this, a historical failed attempt for one of
 *     these tools would silently disappear from the feed the moment its
 *     matrix row was deleted — the allowlist is SQL-filtered
 *     (`tool_id = ANY($allowlist)`), so a tool absent from the allowlist never
 *     reaches the query result at all, regardless of what the row mapper does
 *     with it. This map is NEVER a source for the LIVE matrix — it only adds
 *     entries for toolIds the CURRENT `MUTATION_MATRIX` does not (and will
 *     never again) contain.
 *
 * A tool qualifies when its `expectedType` maps (via TYPE_TO_PRODUCT) to a
 * product in TRANSACTION_PRODUCTS. For dual-type tools (e.g. Polymarket
 * buy/sell → ["prediction", "order"]) the FIRST expectedType that maps to a
 * transaction product is the tool's derived product — deterministic and stable
 * with the matrix declaration order.
 */

import { MUTATION_MATRIX } from "@vex-agent/tools/protocols/mutation-matrix.js";
import { TYPE_TO_PRODUCT } from "@vex-agent/sync/activity-populator.js";

/**
 * Products that count as transactions for the unified feed. A failed mutation
 * whose derived product is NOT in this set (e.g. stake/lp/reward, or a
 * utility tool) is excluded from the failure half. Gates the LIVE
 * `MUTATION_MATRIX` derivation below AND (via `LEGACY_TRANSACTION_PRODUCTS`)
 * the static map's recognized values.
 *
 * `yield` added (Batch B, migration 053): every Pendle mutation — PT/YT/PY,
 * LP add/remove and the reward claim — is now a real wallet-impacting action
 * recorded in `agent_activity` as `kind: 'yield'`, so a FAILED attempt must
 * reach the failure half too. This SUPERSEDES the previous exclusion of
 * Pendle's LP and reward mutations (they were excluded only because their
 * old `lp`/`reward` capture products were not transaction products).
 *
 * `lend` added (Agent Scan Phase 3/W5, migration 049): Jupiter Lend
 * deposit/withdraw are real wallet-impacting mutations with the same
 * pending/confirmed/definitively_failed lifecycle as swaps — a failed
 * `solana.lend.deposit`/`.withdraw` attempt now surfaces here, matching what
 * `TYPE_TO_PRODUCT` (sync/activity-populator.ts) already stores as the
 * success half's `product_type` for the same tools.
 */
export const TRANSACTION_PRODUCTS: ReadonlySet<string> = new Set([
  "spot",
  "perps",
  "prediction",
  "bridge",
  "order",
  "lend",
  "yield",
]);

/**
 * Products that count as transactions ONLY in `LEGACY_TOOL_PRODUCTS` below —
 * `lp` exists ONLY here (never in `TRANSACTION_PRODUCTS`) because the ONLY
 * "lp" product this feed ever surfaces is the DELETED zap tools' history.
 * Pendle's live LP mutations reach the feed under `yield` (see above), not
 * under `lp`.
 */
export const LEGACY_TRANSACTION_PRODUCTS: ReadonlySet<string> = new Set([
  ...TRANSACTION_PRODUCTS,
  "lp",
]);

/**
 * Static map for tools whose product cannot be derived from the live matrix:
 * tools DELETED from the live `MUTATION_MATRIX` by Agent Scan
 * (FIX-SPINE round 1, finding 1/2/16, C9) — a historical `protocol_executions`
 * row for one of these toolIds still surfaces in the failure feed (derived
 * product from THIS map) instead of silently vanishing once the matrix row
 * was removed. Never edit the live `MUTATION_MATRIX` to "keep a tool visible"
 * — add it here instead; this map is the ONLY place deleted-tool product
 * history lives. Every value here MUST be in `LEGACY_TRANSACTION_PRODUCTS`
 * (checked by the test suite).
 */
export const LEGACY_TOOL_PRODUCTS: ReadonlyMap<string, string> = new Map([
  // Pendle (Batch B, card B2) — the ONE case where a LIVE matrix tool needs an
  // entry here. Its `expectedType: "yield"` is deliberately absent from
  // `TYPE_TO_PRODUCT` (that map describes the legacy proj_activity projector,
  // which Pendle no longer feeds), so `deriveTransactionProduct` returns null
  // for these toolIds and THIS map is their single source of product truth —
  // which also means their history survives the matrix rows being deleted.
  ["pendle.pt.buy", "yield"],
  ["pendle.pt.sell", "yield"],
  ["pendle.pt.redeem", "yield"],
  ["pendle.yt.buy", "yield"],
  ["pendle.yt.sell", "yield"],
  ["pendle.py.mint", "yield"],
  ["pendle.py.redeem", "yield"],
  ["pendle.lp.add", "yield"],
  ["pendle.lp.remove", "yield"],
  ["pendle.sy.mint", "yield"],
  ["pendle.sy.redeem", "yield"],
  // R5d card E5 — the dual-leg LP pair (E3) and the three term-mobility moves
  // (E4). Same reasoning as every row above: a FAILED attempt must still be
  // filed under a product, and `yield` is the only one that describes them.
  ["pendle.lp.removeDual", "yield"],
  ["pendle.lp.addKeepYt", "yield"],
  ["pendle.pt.rollover", "yield"],
  ["pendle.lp.transfer", "yield"],
  ["pendle.lp.toPt", "yield"],
  ["pendle.claim", "yield"],
  // Old per-venue swap split, replaced by the unified *.swap.execute pair.
  ["kyberswap.swap.sell", "spot"],
  ["kyberswap.swap.buy", "spot"],
  ["uniswap.swap.sell", "spot"],
  ["uniswap.swap.buy", "spot"],
  // KyberSwap limit orders — deleted wholesale.
  ["kyberswap.limitOrder.create", "order"],
  ["kyberswap.limitOrder.cancel", "order"],
  ["kyberswap.limitOrder.hardCancel", "order"],
  ["kyberswap.limitOrder.fill", "order"],
  ["kyberswap.limitOrder.batchFill", "order"],
  ["kyberswap.limitOrder.cancelAll", "order"],
  // KyberSwap zap — deleted wholesale.
  ["kyberswap.zap.in", "lp"],
  ["kyberswap.zap.out", "lp"],
  ["kyberswap.zap.migrate", "lp"],
  // Polymarket — removed entirely (W5). buy/sell were dual-type
  // (prediction|order); the matched/settled case (prediction) is the more
  // common historical shape, matching the LIVE matrix's own
  // first-expectedType-wins convention for dual-type tools.
  ["polymarket.clob.buy", "prediction"],
  ["polymarket.clob.sell", "prediction"],
  ["polymarket.clob.cancel", "order"],
  ["polymarket.clob.cancelOrders", "order"],
  ["polymarket.clob.cancelAll", "order"],
  ["polymarket.clob.cancelMarket", "order"],
  // Hyperliquid — removed entirely (Agent Scan Phase 3). Only the
  // trade-impacting tools (spot + perps) ever qualified for this feed;
  // funding/vault/staking/reward/builder-fee mutations were always audit-only
  // (expectedType outside TRANSACTION_PRODUCTS) and `risk.proposeSetup` was a
  // non-portfolio-impacting utility tool — none of those get a legacy entry,
  // matching how `polymarket.clob.heartbeat` (also utility) stays absent.
  ["hyperliquid.spot.trade", "spot"],
  ["hyperliquid.perp.open", "perps"],
  ["hyperliquid.perp.close", "perps"],
  ["hyperliquid.perp.setTpsl", "perps"],
  ["hyperliquid.perp.modifyOrder", "perps"],
  ["hyperliquid.perp.cancelOrders", "perps"],
  ["hyperliquid.perp.setLeverage", "perps"],
  ["hyperliquid.perp.adjustMargin", "perps"],
  ["hyperliquid.perp.twap", "perps"],
]);

/** Derive a tool's transaction product from its expectedType, or null. */
function deriveTransactionProduct(expectedType: string | readonly string[]): string | null {
  const types = Array.isArray(expectedType) ? expectedType : [expectedType];
  for (const type of types) {
    const product = TYPE_TO_PRODUCT[type];
    if (product !== undefined && TRANSACTION_PRODUCTS.has(product)) {
      return product;
    }
  }
  return null;
}

/**
 * `tool_id → transaction product` for every trade-impacting mutation tool —
 * CURRENT matrix entries first, then `LEGACY_TOOL_PRODUCTS` fills in any
 * toolId the live matrix no longer has (a live entry always wins if a toolId
 * somehow existed in both, though by construction they never overlap: legacy
 * entries are exactly the toolIds Agent Scan deleted from the matrix).
 */
export const FAILURE_TOOL_PRODUCTS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [toolId, product] of LEGACY_TOOL_PRODUCTS) {
    map.set(toolId, product);
  }
  for (const [toolId, contract] of MUTATION_MATRIX) {
    const product = deriveTransactionProduct(contract.expectedType);
    if (product !== null) {
      map.set(toolId, product);
    }
  }
  return map;
})();

/** The full trade-impacting failure-tool allowlist (every key of the product map — current + legacy). */
export const FAILURE_TOOL_ALLOWLIST: readonly string[] = [...FAILURE_TOOL_PRODUCTS.keys()];

/**
 * The failure-tool allowlist scoped to a productType filter. When `productType`
 * is undefined the full allowlist is returned; when set, only the tools whose
 * derived product === productType (so the failure half filters by DERIVED
 * PRODUCT, never trade_side). An unknown productType yields an empty list →
 * the failure half matches nothing.
 */
export function failureToolsForProduct(productType?: string): readonly string[] {
  if (productType === undefined) return FAILURE_TOOL_ALLOWLIST;
  return FAILURE_TOOL_ALLOWLIST.filter((toolId) => FAILURE_TOOL_PRODUCTS.get(toolId) === productType);
}
