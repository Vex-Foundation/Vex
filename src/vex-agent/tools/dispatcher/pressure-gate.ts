/**
 * Pressure-band hard-deny gate for the dispatcher.
 *
 * Runtime safety net for the context-pressure tool projection: the soft filter
 * (LLM-visible tool catalog) is the first layer; this gate rejects mutating
 * tools the model emits anyway at barrier/critical bands.
 *
 * This is the EXACT MIRROR of `registry/visibility.ts`'s `passesPressureSafety`,
 * including the preparation bypass. The two must always be changed together -
 * a catalog that offers what the dispatcher denies wastes the model's turns,
 * and a dispatcher that allows what the catalog hid makes the barrier hollow.
 */

import type { ToolResult } from "../types.js";
import { getPressureSafety } from "../registry.js";
import type { ContextUsageBand } from "@vex-agent/engine/core/context-band.js";

/**
 * Pressure-band hard-deny check. Returns a synthetic error result when the
 * tool should be blocked at the current band; returns null when dispatch can
 * proceed. Bands `barrier` and `critical` block tools with `pressureSafety
 * === "mutating"`.
 *
 * `preparationBypassesBarrier` suppresses the `mutating` block at `barrier`
 * ONLY (contract C8 - a background compaction is already relieving the
 * pressure). `critical` still blocks. It DEFAULTS TO FALSE so every existing
 * call site keeps today's
 * behaviour: only the live tool-batch path, which computes the flag from the
 * per-turn preparation read, ever passes `true`.
 */
export function checkPressureDeny(
  toolName: string,
  band: ContextUsageBand,
  preparationBypassesBarrier = false,
): ToolResult | null {
  const safety = getPressureSafety(toolName);
  if (safety === undefined) return null; // unknown tool - let routing handle it

  const atBarrier = band === "barrier" || band === "critical";
  const mutatingDropSuppressed = preparationBypassesBarrier && band === "barrier";

  if (atBarrier && safety === "mutating" && !mutatingDropSuppressed) {
    return {
      success: false,
      output:
        `Tool ${toolName} is blocked at context pressure ${band}. ` +
        `The runtime compacts this conversation automatically - no tool call is required from you. ` +
        `Continue with read-only work; the full tool set returns after the compaction lands.`,
    };
  }

  return null;
}
