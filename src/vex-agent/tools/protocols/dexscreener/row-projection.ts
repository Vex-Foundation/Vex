/**
 * Kairos Phase 6, P-6: source-side projection of DexScreener ROW answers for
 * the model-facing text.
 *
 * WHAT IT REMOVES, and only this. Both are values the same answer already
 * states elsewhere, so no fact leaves the answer:
 *
 *  - a row's `window` when the envelope carries the same `window` (every row
 *    of one answer is read on the envelope's window);
 *  - a `derived.<metric>: null` entry when `<metric>` is named in the SAME
 *    row's `derivedUnavailable`, which already says it was withheld and why
 *    (`missingInputs` beside it is untouched).
 *
 * WHAT IT NEVER TOUCHES. Every price, amount, liquidity, volume, market cap,
 * address, chain id, decimals, timestamp and age stays verbatim, as do the
 * envelope's provenance and interpretation notes (`liquidityInterpretation`,
 * `externalContentWarning`, `sourceObservation`, ...), the accounting fields
 * and the issuer-text reports. A row whose shape is not the expected one is
 * passed through unchanged.
 *
 * ONLY THE TEXT. `ToolResult.data` keeps the unprojected object, so any
 * structured consumer (UI enrichment, trade capture) sees exactly today's
 * value; the projection changes `output`, the string the model reads.
 *
 * SWITCH. `AGENT_READ_PROJECTION` (agent-config, default 0). Off returns the
 * handler's result object untouched, so the output is today's, byte for byte.
 *
 * MEASURED on the captured fixtures (`row-projection.test.ts`): see that
 * suite for the before/after bytes per tool.
 */

import { parseAgentReadProjectionEnv } from "../../../../lib/agent-config.js";
import type { ToolResult } from "../../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the projection is on for this answer. Read per call from the env. */
export function readProjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseAgentReadProjectionEnv(env).value;
}

function projectRow(row: unknown, envelopeWindow: string | null): unknown {
  if (!isRecord(row)) return row;
  const projected: Record<string, unknown> = {};
  const unavailable = Array.isArray(row["derivedUnavailable"])
    ? new Set(row["derivedUnavailable"].filter((name): name is string => typeof name === "string"))
    : new Set<string>();
  for (const [key, value] of Object.entries(row)) {
    if (key === "window" && envelopeWindow !== null && value === envelopeWindow) continue;
    if (key === "derived" && isRecord(value)) {
      const derived: Record<string, unknown> = {};
      for (const [metric, metricValue] of Object.entries(value)) {
        if (metricValue === null && unavailable.has(metric)) continue;
        derived[metric] = metricValue;
      }
      projected[key] = derived;
      continue;
    }
    projected[key] = value;
  }
  return projected;
}

/**
 * Project one DexScreener answer's data. Pure; never mutates its input. Data
 * without a top-level `rows` array is returned as is.
 */
export function projectDexScreenerRows(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data["rows"])) return data;
  const envelopeWindow = typeof data["window"] === "string" ? data["window"] : null;
  return { ...data, rows: data["rows"].map((row) => projectRow(row, envelopeWindow)) };
}

/**
 * Apply the projection to a handler's successful result when the switch is on.
 * `data` stays the unprojected object; only `output` is re-serialized.
 */
export function withReadProjection(result: ToolResult, enabled: boolean = readProjectionEnabled()): ToolResult {
  if (!enabled || !result.success || result.data === undefined) return result;
  const projected = projectDexScreenerRows(result.data);
  if (projected === result.data) return result;
  return { ...result, output: JSON.stringify(projected) };
}
