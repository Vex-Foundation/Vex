/**
 * Canonical mutation matrix - single source-of-truth for capture contracts.
 *
 * Imported by runtime.ts (validation, preview detection) and tests (structural
 * coverage). Every mutating protocol tool is classified exactly once.
 *
 * Non-mutating tools are implicit read_only - not listed here.
 *
 * Agent Scan simplification (plan §4.3/§11.4): the PnL role split
 * (pnl_spot/pnl_perps/pnl_prediction) and the `valuationExpected`
 * exact/conditional/none tri-state are REMOVED - no FIFO-lot or exact-USD
 * hard-gate machinery survives (no PnL system computes anything from these
 * captures anymore). `kind` now classifies only the COARSE capture semantics
 * downstream code still needs: `trade` (a swap/position-lifecycle capture that
 * feeds `proj_activity` / `proj_open_positions`), `projection` (orders/LP
 * lifecycle, no PnL), `audit` (balance/state-impact trail only), `utility`
 * (no portfolio impact).
 *
 * `kyberswap.swap.execute` / `uniswap.swap.execute` (the new unified Kyber/
 * Uniswap swap executes, replacing the deleted buy/sell pairs) - from Agent
 * Scan Phase 2, `khalani.bridge` / `relay.bridge` - and, from Agent Scan
 * Phase 3/W5 (migration 049), `solana.lend.deposit` / `solana.lend.withdraw`
 * and `solana.predict.buy` / `.sell` / `.claim` / `.closeAll` - and, from
 * Batch 5 (card B1), `solana.lend.borrowOperate` - are
 * `capture: "none"`: their handler writes the durable truth DIRECTLY to
 * `agent_activity` (via `db/repos/agent-activity.ts`) before/during/after
 * broadcast, so the legacy `proj_activity` projection pipeline below must
 * never also run for them. `capture: "none"` + no `_tradeCapture` on the
 * handler's `ToolResult.data` already makes `capture-pipeline.ts`'s existing
 * "no items → no-op" path skip projection for these tools with ZERO special
 * casing - the entries below exist so this classification is still
 * discoverable/explicit (the file's own invariant: every mutating tool is
 * classified exactly once), not because the skip depends on them.
 */

import type { CaptureSupport } from "./types.js";

// ── Contract per mutation ──────────────────────────────────────

/** Coarse capture semantics - see module doc. No PnL/valuation machinery. */
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
   * substitute for missing per-item `_tradeCaptureItems` - its summary
   * collapses multiple DISTINCT legs (e.g. a Pendle PY mint's PT leg + YT leg)
   * into one mislabeled capture, a portfolio-integrity bug. Batch tools whose
   * summary is a safe fallback (e.g. a batch claim with nothing to
   * distinguish) leave this unset.
   */
  strictItemsRequired?: boolean;
  /**
   * Meta fields required for downstream features beyond the top-level
   * `_tradeCapture` shape. Validated in capture-validator.ts alongside
   * requiredFields. Unused by any current entry - kept for the next
   * protocol whose capture needs a nested meta invariant.
   */
  requiredMetaFields?: readonly string[];
}

// ── Required field sets ──────────────────────────────────────────

// NOTE (Batch B, card B2): with Pendle flipped to `capture: "none"`, NO live
// matrix entry is `capture: "full"` any more - every mutating tool now writes
// its durable truth directly to `agent_activity`. The former TRADE_FIELDS /
// PROJECTION_FIELDS / AUDIT_FIELDS sets had no remaining consumer and were
// removed with the flip; `capture-validator.ts` still enforces
// `requiredFields` generically for the next tool that declares one.
const NO_FIELDS: readonly string[] = [];

// ── Matrix entries ─────────────────────────────────────────────

const entries: [string, MutationContract][] = [
  // ── trade (spot swaps, no PnL - proj_activity capture only) ──

  // KyberSwap/Uniswap/Jupiter unified executes - truth lives in
  // agent_activity, written directly by the handler. `capture: "none"` so
  // this pipeline never also projects proj_activity for these toolIds.
  // `solana.swap.execute` flipped full->none in W5 (design §3/§6, migration
  // 049) with the fee-bearing `/build` atomic flip - same K2 staged Solana
  // seam kyberswap/uniswap already use on EVM.
  ["kyberswap.swap.execute", { kind: "trade", capture: "none", expectedType: "swap", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  ["uniswap.swap.execute",   { kind: "trade", capture: "none", expectedType: "swap", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  ["solana.swap.execute",    { kind: "trade", capture: "none", expectedType: "swap", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // The Virtuals bonding-curve execute is the same shape as the EVM swap
  // executes above: one token in, one token out, an on-chain swap whose durable
  // truth the handler writes to `agent_activity` itself from the receipt, so
  // `capture: "none"` keeps the legacy proj_activity projection out of it. No
  // `dryRun`: the read-only preview is the separate `virtuals.trade.quote`
  // tool, and the execute's own `simulateOnly` stops before signing rather than
  // standing in for an approval-skipping preview.
  ["virtuals.trade.execute", { kind: "trade", capture: "none", expectedType: "swap", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // Trench Express curve buy/sell - the handler writes the durable truth
  // DIRECTLY to agent_activity (kind "swap") across the staged lifecycle, so
  // `capture: "none"` (no proj_activity projection). No dryRun preview.
  ["trench.trade_execute",   { kind: "trade", capture: "none", expectedType: "swap", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // Trench Express token LAUNCH (migration 062). Same direct-write shape: the
  // handler writes its `kind: "launch"` row itself across the staged lifecycle,
  // so `capture: "none"` keeps the legacy proj_activity projection out of it.
  // `kind: "trade"` because a launch with a prebuy acquires a position - and the
  // create plus its initial buy are ONE transaction and ONE activity row, never
  // a second `swap` row for the same tx hash. No dryRun: the read-only dry run
  // is the separate `trench.launch_preview` tool.
  ["trench.launch_execute",  { kind: "trade", capture: "none", expectedType: "launch", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // `trench.launch_request_form` is `mutating: true` with actionKind
  // "local_write": it drafts a durable `token_launch_intents` row and parks the
  // turn for the user, but signs nothing, broadcasts nothing, and writes no
  // agent_activity row. `kind: "utility"` (no portfolio impact) with
  // `capture: "none"` and a placeholder `expectedType` - no `_tradeCapture`
  // ever exists for it.
  ["trench.launch_request_form", { kind: "utility", capture: "none", expectedType: "none", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // pools.fun's two LOCAL-WRITE launch tools. Both are `mutating: true` because
  // each writes a durable row, and neither signs anything: `launch_preview`
  // records an advisory `previewed` intent (non-live by database CHECK - no
  // authorization, no hash), and `launch_request_form` opens the app's form and
  // parks the turn. `capture: "none"` on both, for the same reason the trench
  // form row has it: there is no on-chain effect to capture.
  ["pools.launch_preview",       { kind: "utility", capture: "none", expectedType: "none", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  ["pools.launch_request_form",  { kind: "utility", capture: "none", expectedType: "none", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // `launchpads.image_publish` is the first PROVIDER-SIDE mutation in the
  // matrix: `actionKind: "external_post"`, an HTTP upload of locker bytes to
  // the launch-assets host, idempotent by content, with no chain, no signature
  // and no receipt to capture. It needs no new `CaptureKind`: `utility` already
  // names exactly this - a real mutation with zero portfolio impact and no
  // `_tradeCapture` - so it joins the local-write rows here rather than
  // widening the vocabulary for one tool.
  ["launchpads.image_publish",   { kind: "utility", capture: "none", expectedType: "none", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // The pools.fun LAUNCH itself, shaped exactly like `trench.launch_execute`:
  // the handler writes its `kind: "launch"` row directly across the staged
  // lifecycle, so `capture: "none"` keeps the legacy proj_activity projection
  // out of it, and `kind: "trade"` because a launch with a prebuy acquires a
  // position - the launch and its prebuy are ONE transaction and ONE row. No
  // dryRun: the read-only estimate is the separate `pools.launch_preview` tool.
  ["pools.launch_execute",       { kind: "trade", capture: "none", expectedType: "launch", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // The creator-fee claim. `capture: "none"` for the same reason as every other
  // staged-write handler here: it writes its own row across the lifecycle, so
  // the legacy proj_activity projection must not also run. `expectedType:
  // "claim"` names the product it records - its own kind since migration 082,
  // because a payout is not a launch. `previewSupport: true` because `dryRun` is
  // a real read-only mode of THIS tool rather than a separate preview tool.
  ["pools.claim_fees",           { kind: "trade", capture: "none", expectedType: "claim", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],

  // Pendle PT / YT / PY (Batch B, migration 053) - flipped capture:"full" ->
  // "none" with the same staged `agent_activity` write path the Kyber/Uniswap/
  // Solana executes use: the handler writes the durable truth DIRECTLY as
  // `kind: 'yield'` rows, so the legacy `proj_activity` projection must never
  // also run for these toolIds. `expectedType: "yield"` states the product
  // these tools now record; it is intentionally NOT a `TYPE_TO_PRODUCT` key,
  // so the failure-feed derivation defers to the explicit Pendle entries in
  // `LEGACY_TOOL_PRODUCTS` (db/repos/transactions-failure-tools.ts).
  ["pendle.pt.buy",          { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],
  ["pendle.pt.sell",         { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],
  ["pendle.pt.redeem",       { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],
  ["pendle.yt.buy",          { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],
  ["pendle.yt.sell",         { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],
  // PY mint/redeem stay fanOut:"items" + strictItemsRequired: the 1->2 (mint)
  // and 2->1 (redeem) shape is what migration 053's Option-C second-leg family
  // records, and the flags document that a summary can never stand in for the
  // two distinct legs should capture ever be re-enabled for them.
  ["pendle.py.mint",         { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "items", requiredFields: NO_FIELDS, strictItemsRequired: true }],
  ["pendle.py.redeem",       { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "items", requiredFields: NO_FIELDS, strictItemsRequired: true }],

  // ── trade (predictions - Jupiter/Solana; W5 migration 049 converted
  // buy/sell/claim/closeAll to the staged `agent_activity` write path (K2:
  // createAgentActivityIntent -> prepareVersionedTx -> markActivitySolana
  // Broadcast -> submitPreparedTx), same flip as kyberswap/uniswap/khalani/
  // relay/solana.lend.* above - `capture: "none"` so the legacy
  // `proj_activity` pipeline never also runs for these four toolIds.
  ["solana.predict.buy",     { kind: "trade", capture: "none", expectedType: "prediction", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  ["solana.predict.sell",    { kind: "trade", capture: "none", expectedType: "prediction", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  ["solana.predict.claim",   { kind: "trade", capture: "none", expectedType: "prediction", previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  ["solana.predict.closeAll",{ kind: "trade", capture: "none", expectedType: "prediction", previewSupport: false, fanOut: "items",  requiredFields: NO_FIELDS }],

  // ── projection (LP - lifecycle only, no LP economics) ─────
  // Pendle single-token LP add/remove (P5) - plain lp records only (LP
  // open-position/economics projection was cut for both zap and Pendle;
  // Pendle keeps the lifecycle row, zap's own tools are deleted outright).
  // Flipped capture:"full" -> "none" with the rest of Pendle (Batch B, card B2).
  ["pendle.lp.add",                 { kind: "projection", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],
  ["pendle.lp.remove",              { kind: "projection", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],

  // Pendle SY wrap/unwrap (R5d card D3). One token in, one token out, so `trade`
  // rather than `projection` - same classification as the PT/YT legs. Their quote
  // lives INSIDE the tool as a `dryRun` param, which is exactly what
  // `previewSupport: true` already means here.
  ["pendle.sy.mint",                { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],
  ["pendle.sy.redeem",              { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],

  // Pendle dual-leg LP (R5d card E3). `projection` like the plain lp.add/remove
  // they vary - the LP leg's lifecycle is what gets recorded, not LP economics.
  // fanOut:"items" + strictItemsRequired for BOTH: each produces TWO output
  // instruments (token + PT, and LP + kept YT), and a single summary row could
  // never stand in for two distinct legs - exactly the reason py.mint/redeem
  // carry the same pair of flags.
  ["pendle.lp.removeDual",          { kind: "projection", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "items", requiredFields: NO_FIELDS, strictItemsRequired: true }],
  ["pendle.lp.addKeepYt",           { kind: "projection", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "items", requiredFields: NO_FIELDS, strictItemsRequired: true }],

  // Pendle term mobility (R5d card E4) - one instrument in, one instrument out,
  // so `trade` and fanOut:"single" like the SY pair. `pendle.lp.transfer` is a
  // trade rather than a projection for the same reason: it is one position
  // swapped for another, not liquidity being opened or closed. Their quote
  // lives INSIDE the tool as a `dryRun` param, which is what previewSupport
  // means here.
  ["pendle.pt.rollover",            { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],
  ["pendle.lp.transfer",            { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],
  ["pendle.lp.toPt",                { kind: "trade", capture: "none", expectedType: "yield", previewSupport: true, fanOut: "single", requiredFields: NO_FIELDS }],

  // ── audit (capture: full) ─────────────────────────────────
  // Khalani/Relay bridges (Agent Scan Phase 2, migration 045) write their durable
  // truth DIRECTLY to `agent_activity` (via `db/repos/agent-activity.ts`) across
  // the full staged lifecycle, so `capture: "none"` here - the legacy
  // `proj_activity` projection pipeline must NEVER also run for them (exactly the
  // Phase-1 kyberswap/uniswap flip). The Relay hidden-pair aliases
  // (BridgeQuoteRelay / BridgeExecuteRelay) resolve to `relay.bridge`, so
  // flipping it covers them too. Entries stay listed so the classification is
  // explicit (every mutating tool classified exactly once).
  ["khalani.bridge",           { kind: "audit", capture: "none", expectedType: "bridge", previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  ["relay.bridge",             { kind: "audit", capture: "none", expectedType: "bridge", previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  // Jupiter Lend deposit/withdraw (Agent Scan Phase 3/W5, migration 049) -
  // converted to the staged `agent_activity` write path (K2/K6): the handler
  // writes its durable truth DIRECTLY (createAgentActivityIntent →
  // prepareVersionedTx → markActivitySolanaBroadcast → submitPreparedTx), so
  // `capture: "none"` here - the legacy `proj_activity` projection pipeline
  // must NEVER also run for these two, exactly the khalani.bridge/relay.bridge
  // flip above.
  ["solana.lend.deposit",      { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  ["solana.lend.withdraw",     { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // Morpho vault supply / redeem (E3b-2). `capture: "none"` for the same reason
  // as every row above it: the handler's durable truth is the `agent_activity`
  // row written by `morpho/handlers/signed-broadcast.ts`, so the legacy
  // projection pipeline must never also run for it. `previewSupport: true`
  // because BOTH tools take `dryRun`, which returns the full preview (allowance
  // plan included) and signs nothing, so the runtime skips approval and capture
  // for it.
  ["morpho.vault.deposit",     { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  ["morpho.vault.withdraw",    { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  // Morpho Blue market operations (E3c). Same contract as the two vault rows
  // above and for the same reasons: the durable truth is the `agent_activity`
  // row written by `morpho/handlers/signed-broadcast.ts`, so the legacy
  // projection pipeline must never also run; all four take `dryRun`, which
  // returns the full preview and signs nothing. `expectedType: "lend"` because
  // the borrow lane is the same lending domain as the vaults - the market
  // operations move a position within it rather than trading a pair. The two
  // LENDER-side entries below are the same contract again: `supply` and
  // `withdraw` lend the market's loan asset in and take it back out.
  ["morpho.market.supplyCollateral",   { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  ["morpho.market.withdrawCollateral", { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  ["morpho.market.borrow",             { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  ["morpho.market.repay",              { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  ["morpho.market.supply",             { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  ["morpho.market.withdraw",           { kind: "audit", capture: "none", expectedType: "lend",   previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  // Morpho reward claim. `expectedType: "yield"` and NOT "lend", matching the
  // `yield` / `yield_claim` row the lane writes and matching `pendle.claim`
  // below: the type describes the OPERATION, and sweeping an already-earned
  // incentive balance is income wherever it was earned. Same `capture: "none"`
  // and `previewSupport: true` as its siblings.
  ["morpho.rewards.claim",             { kind: "audit", capture: "none", expectedType: "yield",  previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
  // Jupiter Lend BORROW `/operate` (Agent Scan Phase 3 Batch 5, card B1) -
  // full lifecycle (create/deposit/withdraw/borrow/repay) on the SAME K2
  // staged `agent_activity` write path as the two Earn tools above -
  // `capture: "none"` for the identical reason.
  ["solana.lend.borrowOperate", { kind: "audit", capture: "none", expectedType: "lend",  previewSupport: false, fanOut: "single", requiredFields: NO_FIELDS }],
  // Pendle income sweep - claims accrued YT interest + rewards / LP rewards to
  // the wallet. Not a spot trade (no input/output pair, no principal moved) →
  // audited as a "reward" income event.
  ["pendle.claim",             { kind: "audit", capture: "none", expectedType: "yield", previewSupport: true,  fanOut: "single", requiredFields: NO_FIELDS }],
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
