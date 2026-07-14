/**
 * Wallet send — shared `ToolResult` constructors for the prepare/confirm
 * handlers and outcome finalisation. Single-instanced helpers so prepare,
 * confirm, and finalize all produce the identical `ToolResult` shape.
 */

import type { ToolResult } from "../../../types.js";

export function ok(data: unknown): ToolResult {
  return {
    success: true,
    output: JSON.stringify(data, null, 2),
    data: data as Record<string, unknown>,
  };
}

export function fail(msg: string): ToolResult {
  return { success: false, output: msg };
}

/**
 * Failed `ToolResult` that still carries structured `data` — used when a
 * broadcast-but-failed transfer has a real tx hash to surface (metadata-only,
 * e.g. `{ _explorerRefs }`). The model-visible `output` string is identical to
 * `fail(msg)`; only the out-of-band `data` differs.
 */
export function failWith(msg: string, data: Record<string, unknown>): ToolResult {
  return { success: false, output: msg, data };
}
