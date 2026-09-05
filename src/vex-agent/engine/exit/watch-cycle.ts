/**
 * Watch cycle — pure, deterministic per-tick orchestrator for the exit engine.
 *
 * Given the open positions, a price lookup, the current wall-clock (passed IN)
 * and the static exit config, `runWatchCycle` produces one `WatchAlert` per
 * position:
 *   - refreshes the high-water peak (max of the carried peak and the new price);
 *   - runs the pure `evaluateExit` rule engine against that refreshed peak;
 *   - reports the decisions plus the peak the caller should persist.
 *
 * PURE and TOTAL by construction: no I/O, no Date.now, no randomness, and a
 * missing or garbage price — or a `priceOf` that throws — degrades to a
 * `price_unavailable` alert rather than an exception, so one bad token lookup
 * can never abort the rest of the sweep. Pricing is the flakiest input in the
 * system, which is why that isolation lives here rather than in the caller.
 *
 * This module decides NOTHING about money or execution. It surfaces alerts;
 * what a caller does with one is out of scope, and is expected to go through
 * the app's existing approval path.
 */

import {
  evaluateExit,
  type ExitConfig,
  type ExitDecision,
  type Position,
} from "./exit-rules.js";

export interface WatchInputPosition {
  readonly token: string;
  readonly entryPriceUsd: number;
  readonly amountTokens: number;
  readonly openedAtMs: number;
  readonly consumedRungs: readonly number[];
  /** High-water price carried from the last cycle (>= entry). */
  readonly priorPeakPriceUsd: number;
}

export interface WatchAlert {
  readonly token: string;
  /** Peak the caller should persist for the next cycle. */
  readonly updatedPeakPriceUsd: number;
  /** Null when the price lookup missed or returned garbage. */
  readonly currentPriceUsd: number | null;
  /** Exit decisions that fired this tick; [] when nothing fires or price is missing. */
  readonly decisions: ExitDecision[];
  /** Diagnostic note, e.g. "price_unavailable". */
  readonly note?: string;
}

/** True for a real, strictly-positive number. */
function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * Resolve a price via `priceOf`, degrading EVERY failure mode to `null`: a
 * thrown lookup, `null` / `undefined`, or a non-finite / non-positive number
 * are all "unavailable".
 */
function safePrice(
  priceOf: (token: string) => number | null | undefined,
  token: string,
): number | null {
  let raw: number | null | undefined;
  try {
    raw = priceOf(token);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) {
    return null;
  }
  return isPositiveFinite(raw) ? raw : null;
}

/**
 * Evaluate every open position once. Returns one alert per input position, in
 * input order — including for positions that could not be priced, so a caller
 * can distinguish "nothing fired" from "we did not look".
 */
export function runWatchCycle(
  positions: readonly WatchInputPosition[],
  priceOf: (token: string) => number | null | undefined,
  nowMs: number,
  config: ExitConfig,
): WatchAlert[] {
  const alerts: WatchAlert[] = [];

  for (const input of positions) {
    const price = safePrice(priceOf, input.token);

    // Price missing or garbage → carry the peak unchanged, surface no decisions.
    // Proposing an exit off a stale price is worse than proposing nothing.
    if (price === null) {
      alerts.push({
        token: input.token,
        updatedPeakPriceUsd: input.priorPeakPriceUsd,
        currentPriceUsd: null,
        decisions: [],
        note: "price_unavailable",
      });
      continue;
    }

    // High-water refresh: the peak only ever ratchets up.
    const updatedPeakPriceUsd = Math.max(input.priorPeakPriceUsd, price);

    const position: Position = {
      token: input.token,
      entryPriceUsd: input.entryPriceUsd,
      amountTokens: input.amountTokens,
      peakPriceUsd: updatedPeakPriceUsd,
      openedAtMs: input.openedAtMs,
      consumedRungs: input.consumedRungs,
    };

    alerts.push({
      token: input.token,
      updatedPeakPriceUsd,
      currentPriceUsd: price,
      decisions: evaluateExit(position, price, nowMs, config),
    });
  }

  return alerts;
}
