/**
 * Shared protocol handler helpers - extracted from duplicated per-handler utilities.
 *
 * str/num/ok/fail are used identically in all 13 handler files.
 * Consolidating here per Team Standards §2.3 (stop on repetition, 3+ = extract).
 *
 * `enumField` is re-exported from `tools/internal/types.ts` where it already
 * exists - same helper, one source of truth. Post-PR1 the protocol runtime
 * validates `ProtocolParamDef.type` (string/number/boolean) at the
 * execute_tool boundary, so by the time a handler calls `enumField` the
 * value is guaranteed to be a string (or missing); the helper narrows it
 * further to the SDK-expected enum set.
 */

import type { ToolResult } from "../types.js";

export { enumField } from "../internal/types.js";

/**
 * Widen an SDK response value to `ToolResult.data`'s open
 * `Record<string, unknown>` shape. The runtime value is structurally
 * compatible - the double-cast exists only because TypeScript rejects
 * `typed-object → Record<string, unknown>` for interfaces without an
 * index signature. Centralising it here keeps handlers that pass through
 * a typed SDK result to one acknowledged unsafe line instead of
 * scattering `as unknown as` around the handler files.
 *
 * Use this ONLY when you are intentionally exposing an SDK response
 * directly as `ToolResult.data`. Prefer constructing a plain object
 * literal (`data: { count, items }`) when the output already wraps the
 * response.
 */
export function toResultData(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Safe string accessor from params. */
export function str(p: Record<string, unknown>, k: string): string {
  const v = p[k]; return typeof v === "string" ? v : "";
}

/** Safe number accessor from params. */
export function num(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k]; return typeof v === "number" ? v : undefined;
}

/** Success result with JSON output. */
export function ok(data: unknown): ToolResult {
  return { success: true, output: JSON.stringify(data), data: data as Record<string, unknown> };
}

/** Failure result with message. */
export function fail(msg: string): ToolResult {
  return { success: false, output: msg };
}

/** Safe boolean accessor from params. */
export function bool(p: Record<string, unknown>, k: string): boolean | undefined {
  return typeof p[k] === "boolean" ? (p[k] as boolean) : undefined;
}

/** Comma-separated string → trimmed string array. Returns undefined if empty/missing. */
export function strArray(p: Record<string, unknown>, k: string): string[] | undefined {
  const v = typeof p[k] === "string" ? (p[k] as string) : "";
  if (!v) return undefined;
  const arr = v.split(",").map(s => s.trim()).filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

/** Comma-separated string → number array. Filters out non-finite values. Returns undefined if empty/missing. */
export function numArray(p: Record<string, unknown>, k: string): number[] | undefined {
  const v = typeof p[k] === "string" ? (p[k] as string) : "";
  if (!v) return undefined;
  const arr = v.split(",").map(Number).filter(n => Number.isFinite(n));
  return arr.length > 0 ? arr : undefined;
}

// ── Native gas reserve (future) ─────────────────────────────────
// TODO: Runtime gas reserve backstop for native-token spends.
// Currently enforced via prompt only (DeFi Safety Rules in tool-usage.ts).
// If prompt-level guidance proves insufficient, add safeNativeAmount()
// here that deducts ~10% reserve when spending >90% of native balance.
// Requires moving getKyberEvmClients() before route quote in executeKyberSwap()
// so publicClient.getBalance() is available before amountIn is used.
