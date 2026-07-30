/**
 * Context-usage band — classification of prompt pressure relative to the
 * provider's context window. Drives:
 *   - tool-surface projection (the LLM-visible catalog is narrowed to
 *     `safe_at_barrier` + `read_only` once band reaches
 *     `barrier`),
 *   - dispatcher hard-deny on mutating tools at barrier+,
 *   - the runtime forced-fallback compact at `critical` (when the agent
 *     did not relieve the pressure itself),
 *   - the system-prompt context-pressure banner.
 *
 * Band is derived from the lagging `sessions.token_count` (the previous
 * prompt's token count, set by `executeTurn` after each completion). This
 * is one turn behind the real pressure, but it's the only signal available
 * before the next provider call — projecting token count pre-prompt would
 * require running the tokenizer, which is out of scope.
 *
 * Thresholds come from `context-pressure-policy.ts` so the policy layer owns the
 * single source of truth. `contextLimit <= 0` is treated as a degenerate
 * config (no meaningful pressure) → always `"normal"`. Prevents
 * division-by-zero.
 */

import {
  PRESSURE_WARNING_FRACTION,
  PRESSURE_BARRIER_FRACTION,
  PRESSURE_CRITICAL_FRACTION,
  classifyPressure,
  type PressureBand,
} from "@vex-agent/engine/core/context-pressure-policy.js";

export type ContextUsageBand = PressureBand;

export {
  PRESSURE_WARNING_FRACTION,
  PRESSURE_BARRIER_FRACTION,
  PRESSURE_CRITICAL_FRACTION,
};

export function computeBand(
  tokenCount: number,
  contextLimit: number,
): ContextUsageBand {
  if (!Number.isFinite(tokenCount) || tokenCount <= 0) return "normal";
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) return "normal";
  return classifyPressure(tokenCount / contextLimit);
}

/**
 * True iff the band restricts mutating tools at dispatch. Both `barrier`
 * and `critical` are "at-or-past barrier" — the dispatcher's hard-deny and
 * the LLM-catalog narrowing fire identically across them; only the
 * runtime-side forced fallback differentiates the two.
 */
export function isPressureBarrier(band: ContextUsageBand): boolean {
  return band === "barrier" || band === "critical";
}

/**
 * True iff the band is `critical` — the runtime trigger for forced
 * fallback compact.
 */
export function isPressureCritical(band: ContextUsageBand): boolean {
  return band === "critical";
}

const BAND_ORDER: readonly ContextUsageBand[] = ["normal", "warning", "barrier", "critical"];

export function bandRank(band: ContextUsageBand): number {
  return BAND_ORDER.indexOf(band);
}

/**
 * Result of a single band observation. `emit === true` iff the caller should
 * surface a `compact.band_observed` log line: either the initial observation
 * was already elevated above `normal`, or this observation crosses upward
 * from a strictly lower band. Downward / same-band observations return
 * `emit: false` but still rotate the observer's internal `previousBand` so a
 * later upward transition still triggers correctly.
 */
export interface BandObservation {
  readonly band: ContextUsageBand;
  readonly emit: boolean;
  readonly fromBand: ContextUsageBand | null;
}

/**
 * Per-loop band observer. Captures `previousBand` in closure state so a single
 * runTurnLoop invocation tracks transitions across all its iterations. Tests
 * exercise this factory directly; the production caller wraps it with the
 * logger emit.
 */
export function createBandObserver(
  /**
   * A GETTER is accepted alongside a fixed number because the effective window
   * is no longer constant for a session: endpoint failover can switch a session
   * to an endpoint with a narrower window mid-run, and a band computed against
   * the old window would under-report pressure exactly when it matters (owner
   * decision 7). The `previousBand` state deliberately survives a limit change,
   * so a shrinking window shows up as a genuine upward transition rather than
   * resetting the observer.
   */
  contextLimit: number | (() => number),
): (tokenCount: number) => BandObservation {
  const resolveLimit =
    typeof contextLimit === "function" ? contextLimit : () => contextLimit;
  let previousBand: ContextUsageBand | null = null;
  return (tokenCount: number): BandObservation => {
    const band = computeBand(tokenCount, resolveLimit());
    const isInitialElevated = previousBand === null && band !== "normal";
    const isUpwardTransition =
      previousBand !== null && bandRank(band) > bandRank(previousBand);
    const fromBand = previousBand;
    previousBand = band;
    return { band, emit: isInitialElevated || isUpwardTransition, fromBand };
  };
}

/**
 * Compute the token-fraction used by the context-pressure banner. Returns
 * a clamped [0, 1] value safe to format as a percentage.
 */
export function pressureFraction(tokenCount: number, contextLimit: number): number {
  if (!Number.isFinite(tokenCount) || tokenCount <= 0) return 0;
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) return 0;
  const raw = tokenCount / contextLimit;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}
