/**
 * Swap prequote recording (Stage 6c) + execute-time gate (Stage 7).
 *
 * COMPATIBILITY FAÇADE. The implementation was split into focused modules under
 * `./prequote/` (registry, identity hash/bridge, safety extraction, recorder,
 * execute gate); this file preserves the original public surface so existing
 * importers (`./runtime.ts`, the prequote tests) keep working unchanged. Read
 * the per-module docs for behavior - this file only re-exports.
 *
 * RECORDER - for a SUCCESSFUL swap QUOTE this records a deterministic
 * match-hash + a 3-state token-safety verdict + a bounded `safetyDetail` row
 * (best-effort; never alters the quote's ToolResult). A missing prequote is
 * safe - the Stage-7 gate blocks the execute instead.
 *
 * GATE (`evaluateSwapPrequoteGate`) - before a swap EXECUTE broadcasts, this
 * enforces quote-before-transaction. It BLOCKS on (no fresh matching `swap`
 * prequote) OR (a fresh `fail` row); both `pass` AND `unknown` PASS the gate.
 * The gate is the INVERSE of the recorder: the recorder swallows errors, the
 * gate FAILS CLOSED to BLOCK on any error / missing session / un-gateable token
 * identity.
 */

// ── Registry (quote tools, gate tools, freshness window) ───────────────────
export {
  PREQUOTE_QUOTE_TOOLS,
  PREQUOTE_MAX_AGE_MS,
  EXECUTE_GATE_TOOLS,
} from "./prequote/registry.js";
export type { ExecuteGateRegistration } from "./prequote/registry.js";

// ── Match-hash + identity shapes ───────────────────────────────────────────
export { computePrequoteMatchHash } from "./prequote/identity/hash.js";
export type {
  SwapMatchInput,
  BridgeMatchInput,
  PrequoteMatchInput,
  BridgeTradeType,
} from "./prequote/identity/hash.js";

// ── Shared bridge identity builder (record-time AND gate-time) ─────────────
export { buildBridgeIdentity } from "./prequote/identity/bridge.js";

// ── Verdict computation + extraction ───────────────────────────────────────
export { extractQuote } from "./prequote/safety/extract.js";

// ── Recorder ──────────────────────────────────────────────────────────────
export { recordPrequoteFromQuote } from "./prequote/record.js";

// ── Stage 7 - execute-time prequote gate ────────────────────────────────────
export {
  evaluatePrequoteGate,
  evaluateSwapPrequoteGate,
  findFreshMatchedPrequote,
} from "./prequote/gate.js";
export type {
  GateDecision,
  MatchedPrequote,
  MatchedPrequoteRefusal,
} from "./prequote/gate.js";
