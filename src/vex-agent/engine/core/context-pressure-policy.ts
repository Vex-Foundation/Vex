/**
 * Context-pressure policy — ENGINE-owned constants and classifier for the
 * token-budget pressure bands. The bands gate tool-surface projection, the
 * system-prompt context-pressure banner, the runtime forced-fallback compact,
 * and the post-compact bridge resume packet.
 *
 * Lives in the engine (not the memory module): pressure is a property of the
 * inference context window, not of the memory subsystem. No DB, no embeddings,
 * no I/O. Tested as plain unit tests.
 */

// ── Pressure bands ──────────────────────────────────────────────

/**
 * Token-budget fraction at which the informational banner appears in the system prompt.
 *
 * Lowered 0.85 → 0.80: the barrier at 0.88 hard-denies every mutating tool and narrows the
 * LLM-visible catalog, so the window in which the agent could still act AND knew it should
 * compact was only 3 percentage points wide. Widening it to 8 gives the agent real runway to
 * finish what it is doing and call `compact_now` itself before the barrier removes its ability
 * to act at all.
 *
 * The band ordering `0 < WARNING < BARRIER < CRITICAL <= 1` is a hard invariant — `classifyPressure`
 * tests the thresholds top-down and silently mis-bands if it is broken. Pinned by
 * `src/__tests__/vex-agent/engine/core/context-band.test.ts`.
 */
export const PRESSURE_WARNING_FRACTION = 0.80;

/** Token-budget fraction at which the hard compact barrier engages (tools restricted). */
export const PRESSURE_BARRIER_FRACTION = 0.88;

/** Token-budget fraction at which the runtime forced-fallback fires (agent did not call compact_now). */
export const PRESSURE_CRITICAL_FRACTION = 0.92;

/** Number of turns post-compact during which the deterministic bridge resume packet is injected. */
export const POST_COMPACT_BRIDGE_CYCLES = 2;

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Classify a token-budget fraction into a pressure band. The bands gate tool
 * visibility, system prompt banners, and runtime forced-fallback behavior.
 */
export type PressureBand = "normal" | "warning" | "barrier" | "critical";

export function classifyPressure(fraction: number): PressureBand {
  if (!Number.isFinite(fraction) || fraction < 0) return "normal";
  if (fraction >= PRESSURE_CRITICAL_FRACTION) return "critical";
  if (fraction >= PRESSURE_BARRIER_FRACTION) return "barrier";
  if (fraction >= PRESSURE_WARNING_FRACTION) return "warning";
  return "normal";
}
