/**
 * Canonical mutation matrix — single source-of-truth for capture contracts.
 *
 * Imported by runtime.ts (validation, preview detection) and tests (structural
 * coverage). Every mutating protocol tool is classified exactly once.
 *
 * Non-mutating tools are implicit read_only — not listed here.
 *
 * Agent Scan simplification (plan §4.3/§11.4): the PnL role split
 * (pnl_spot/pnl_perps/pnl_prediction) and the `valuationExpected`
 * exact/conditional/none tri-state are REMOVED — no FIFO-lot or exact-USD
 * hard-gate machinery survives (no PnL system computes anything from these
 * captures anymore). `kind` now classifies only the COARSE capture semantics
 * downstream code still needs: `trade` (a swap/position-lifecycle capture that
 * feeds `proj_activity` / `proj_open_positions`), `projection` (orders/LP
 * lifecycle, no PnL), `audit` (balance/state-impact trail only), `utility`
 * (no portfolio impact).
 *
 * `kyberswap.swap.execute` / `uniswap.swap.execute` (the new unified Kyber/
 * Uniswap swap executes, replacing the deleted buy/sell pairs) are
 * `capture: "none"` — their handler writes the durable truth DIRECTLY to
 * `agent_activity` (via `db/repos/agent-activity.ts`) before/during/after
 * broadcast, so the legacy `proj_activity` projection pipeline below must
 * never also run for them. `capture: "none"` + no `_tradeCapture` on the
 * handler's `ToolResult.data` already makes `capture-pipeline.ts`'s existing
 * "no items → no-op" path skip projection for these tools with ZERO special
 * casing — the entries below exist so this classification is still
 * discoverable/explicit (the file's own invariant: every mutating tool is
 * classified exactly once), not because the skip depends on them.
 */

import type { CaptureSupport } from "./types.js";

// ── Contract per mutation ──────────────────────────────────────

/** Coarse capture semantics — see module doc. No PnL/valuation machinery. */
export type CaptureKind = "trade" | "projection" | "audit" | "utility";

export interface MutationContract {
  /** Coarse capture semantics for downstream projections (no PnL role split). */
  kind: CaptureKind;
  /** Whether handler produces _tradeCapture. */
  capture: CaptureSupport;
  /** Expected _tradeCapture.type value(s). Array for dual-type tools. */
  expectedType: string | string[];
  /** Handler supports dryRun param → runtime skips approval + capture for previews. */
  previewSupport: boolean;
  /** Single _tradeCapture vs _tradeCaptureItems for bulk operations. */
  fanOut: "single" | "items";
  /** Minimum required fields in _tradeCapture for capture:"full". Empty for capture:"none". */
  requiredFields: readonly string[];
  /** Named exceptions to requiredFields (e.g. "claim: no instrumentKey"). */
  exceptions?: readonly string[];
  /**
   * A `fanOut: "items"` tool whose SUMMARY `_tradeCapture` must NEVER
   * substitute for missing per-item `_tradeCaptureItems` — its summary
   * collapses multiple DISTINCT legs (e.g. a Pendle PY mint's PT leg + YT leg)
   * into one mislabeled capture, a portfolio-integrity bug. Batch tools whose
   * summary is a safe fallback (e.g. a batch claim with nothing to
   * distinguish) leave this unset.
   */
  strictItemsRequired?: boolean;
  /**
   * Meta fields required for downstream features (e.g. Hyperliquid protection
   * state). Validated in capture-validator.ts alongside requiredFields.
   */
  requiredMetaFields?: readonly string[];
}

// ── Required field sets ──────────────────────────────────────────

const TRADE_FIELDS = [
  "type", "walletAddress", "tradeSide", "instrumentKey",
  "inputTokenAddress", "outputTokenAddress", "inputAmount", "outputAmount",
] as const;

const PREDICTION_FIELDS = [
  "type", "walletAddress", "status", "positionKey", "instrumentKey",
] as const;

/** Netted perp position snapshots, consumed by the existing lifecycle projector. */
const PERPS_FIELDS = [
  "type", "walletAddress", "status", "positionKey", "instrumentKey",
] as const;

const PROJECTION_FIELDS = [
  "type", "positionKey", "status",
] as const;

const AUDIT_FIELDS = [
  "type", "walletAddress", "status",
] as const;

const NO_FIELDS: readonly string[] = [];

// ── Matrix entries ─────────────────────────────────────────────

const entries: [string, MutationContract][] = [
  // ── trade (spot swaps, no PnL — proj_activity capture only) ──
  ["solana.swap.execute",    { kind: "trade", capture: "full", expectedType: "swap", previewSupport: false, fanOut: "single", requiredFields: TRADE_FIELDS, exceptions: ["neutral swap: no tradeSide when meta.stableSwap or meta.ambiguousSwap"] }],

  // KyberSwap/Uniswap unified executes (Agent Scan §11.1) — truth lives in
  // agent_activity, written directly by the handler. `capture: "none"` so
  // this pipeline never also projects proj_activity for these toolIds.
  ["kyberswap.swap.execute", { kind: "trade", capture: "none", expectedType: "swap", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  ["uniswap.swap.execute",   { kind: "trade", capture: "none", expectedType: "swap", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],

  // Pendle fixed-yield PT (Ethereum v1). All three capture as spot swaps: buy
  // opens a PT lot, sell (early exit) + redeem (matured, ~face) close it.
  ["pendle.pt.buy",          { kind: "trade", capture: "full", expectedType: "swap", previewSupport: true, fanOut: "single", requiredFields: TRADE_FIELDS }],
  ["pendle.pt.sell",         { kind: "trade", capture: "full", expectedType: "swap", previewSupport: true, fanOut: "single", requiredFields: TRADE_FIELDS }],
  ["pendle.pt.redeem",       { kind: "trade", capture: "full", expectedType: "swap", previewSupport: true, fanOut: "single", requiredFields: TRADE_FIELDS }],

  // Pendle YT (variable/leveraged yield). Buy opens a YT lot, early-exit sell
  // closes it. No redeem — a YT decays to zero rather than maturing to face.
  ["pendle.yt.buy",          { kind: "trade", capture: "full", expectedType: "swap", previewSupport: true, fanOut: "single", requiredFields: TRADE_FIELDS }],
  ["pendle.yt.sell",         { kind: "trade", capture: "full", expectedType: "swap", previewSupport: true, fanOut: "single", requiredFields: TRADE_FIELDS }],

  // Pendle PY mint / pre-expiry redeem (P4). ONE execution, TWO capture items (a
  // PT leg + a YT leg) with DISTINCT instrument keys → fanOut:"items" AND
  // strictItemsRequired (the summary must never substitute for the two items).
  ["pendle.py.mint",         { kind: "trade", capture: "full", expectedType: "swap", previewSupport: true, fanOut: "items", requiredFields: TRADE_FIELDS, strictItemsRequired: true }],
  ["pendle.py.redeem",       { kind: "trade", capture: "full", expectedType: "swap", previewSupport: true, fanOut: "items", requiredFields: TRADE_FIELDS, strictItemsRequired: true }],
  ["hyperliquid.spot.trade", { kind: "trade", capture: "full", expectedType: "swap", previewSupport: false, fanOut: "single", requiredFields: TRADE_FIELDS }],

  // ── trade (predictions — lifecycle preserved; Jupiter/Solana only this phase) ──
  ["solana.predict.buy",     { kind: "trade", capture: "full", expectedType: "prediction", previewSupport: false, fanOut: "single", requiredFields: PREDICTION_FIELDS, requiredMetaFields: ["contracts"] }],
  ["solana.predict.sell",    { kind: "trade", capture: "full", expectedType: "prediction", previewSupport: false, fanOut: "single", requiredFields: PREDICTION_FIELDS }],
  ["solana.predict.claim",   { kind: "trade", capture: "full", expectedType: "prediction", previewSupport: false, fanOut: "single", requiredFields: ["walletAddress", "status", "positionKey"], exceptions: ["claim: no instrumentKey — matches via positionKey"] }],
  ["solana.predict.closeAll",{ kind: "trade", capture: "full", expectedType: "prediction", previewSupport: false, fanOut: "items", requiredFields: PREDICTION_FIELDS, exceptions: ["closeAll claim item: no instrumentKey — matches via positionKey"] }],

  // Hyperliquid mutations capture the post-action clearinghouse snapshot, so
  // scale in/out projects netted truth without changing the shared projector.
  ["hyperliquid.perp.open",         { kind: "trade", capture: "full", expectedType: "perps", previewSupport: false, fanOut: "single", requiredFields: PERPS_FIELDS, requiredMetaFields: ["coin", "contracts", "protectionState"] }],
  ["hyperliquid.perp.close",        { kind: "trade", capture: "full", expectedType: "perps", previewSupport: false, fanOut: "single", requiredFields: PERPS_FIELDS, requiredMetaFields: ["coin", "contracts", "protectionState"] }],
  ["hyperliquid.perp.setTpsl",      { kind: "trade", capture: "full", expectedType: "perps", previewSupport: false, fanOut: "single", requiredFields: PERPS_FIELDS, requiredMetaFields: ["coin", "contracts", "protectionState"] }],
  ["hyperliquid.perp.modifyOrder",  { kind: "trade", capture: "full", expectedType: "perps", previewSupport: false, fanOut: "single", requiredFields: PERPS_FIELDS, requiredMetaFields: ["coin", "contracts", "protectionState"] }],
  ["hyperliquid.perp.cancelOrders", { kind: "trade", capture: "full", expectedType: "perps", previewSupport: false, fanOut: "single", requiredFields: PERPS_FIELDS, requiredMetaFields: ["coin", "contracts", "protectionState"] }],
  ["hyperliquid.perp.setLeverage",  { kind: "trade", capture: "full", expectedType: "perps", previewSupport: false, fanOut: "single", requiredFields: PERPS_FIELDS, requiredMetaFields: ["coin", "contracts", "protectionState"] }],
  ["hyperliquid.perp.adjustMargin", { kind: "trade", capture: "full", expectedType: "perps", previewSupport: false, fanOut: "single", requiredFields: PERPS_FIELDS, requiredMetaFields: ["coin", "contracts", "protectionState"] }],
  ["hyperliquid.perp.twap",         { kind: "trade", capture: "full", expectedType: "perps", previewSupport: false, fanOut: "single", requiredFields: PERPS_FIELDS, requiredMetaFields: ["coin", "contracts", "protectionState"] }],
  ["hyperliquid.risk.proposeSetup", { kind: "utility", capture: "none", expectedType: "social", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],

  // Hyperliquid funding, vault, staking and reward mutations are account
  // operations, not trade lots. Keep their captures audit-only.
  ["hyperliquid.deposit",           { kind: "audit", capture: "full", expectedType: "transfer", previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["hyperliquid.transfer.usdClass", { kind: "audit", capture: "full", expectedType: "account", previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["hyperliquid.withdraw",          { kind: "audit", capture: "full", expectedType: "transfer", previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["hyperliquid.transfer.send",     { kind: "audit", capture: "full", expectedType: "transfer", previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["hyperliquid.vault.transfer",    { kind: "audit", capture: "full", expectedType: "lp", previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["hyperliquid.staking.delegate",  { kind: "audit", capture: "full", expectedType: "stake", previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["hyperliquid.staking.transfer",  { kind: "audit", capture: "full", expectedType: "stake", previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["hyperliquid.rewards.claim",     { kind: "audit", capture: "full", expectedType: "reward", previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["hyperliquid.builder.approveFee", { kind: "audit", capture: "full", expectedType: "account", previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],

  // ── projection (LP — lifecycle only, no LP economics) ─────
  // Pendle single-token LP add/remove (P5) — plain lp records only (LP
  // open-position/economics projection was cut for both zap and Pendle;
  // Pendle keeps the lifecycle row, zap's own tools are deleted outright).
  ["pendle.lp.add",                 { kind: "projection", capture: "full", expectedType: "lp", previewSupport: true, fanOut: "single", requiredFields: PROJECTION_FIELDS }],
  ["pendle.lp.remove",              { kind: "projection", capture: "full", expectedType: "lp", previewSupport: true, fanOut: "single", requiredFields: PROJECTION_FIELDS }],

  // ── audit (capture: full) ─────────────────────────────────
  ["khalani.bridge",           { kind: "audit", capture: "full", expectedType: "bridge", previewSupport: true,  fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["relay.bridge",             { kind: "audit", capture: "full", expectedType: "bridge", previewSupport: true,  fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["solana.lend.deposit",      { kind: "audit", capture: "full", expectedType: "lend",   previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  ["solana.lend.withdraw",     { kind: "audit", capture: "full", expectedType: "lend",   previewSupport: false, fanOut: "single", requiredFields: AUDIT_FIELDS }],
  // Pendle income sweep — claims accrued YT interest + rewards / LP rewards to
  // the wallet. Not a spot trade (no input/output pair, no principal moved) →
  // audited as a "reward" income event.
  ["pendle.claim",             { kind: "audit", capture: "full", expectedType: "reward", previewSupport: true,  fanOut: "single", requiredFields: AUDIT_FIELDS }],
];

// ── Exported map ───────────────────────────────────────────────

export const MUTATION_MATRIX: ReadonlyMap<string, MutationContract> = new Map(entries);

// ── Helpers ────────────────────────────────────────────────────

/** Check if a type matches the expectedType (supports string | string[]). */
export function isExpectedType(contract: MutationContract, actualType: string): boolean {
  if (Array.isArray(contract.expectedType)) {
    return contract.expectedType.includes(actualType);
  }
  return contract.expectedType === actualType;
}

/** Get all toolIds in the matrix. */
export function getMatrixToolIds(): string[] {
  return entries.map(([id]) => id);
}

/** Get tools by capture kind. */
export function getToolsByKind(kind: CaptureKind): [string, MutationContract][] {
  return entries.filter(([, c]) => c.kind === kind);
}
