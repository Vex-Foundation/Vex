/**
 * Exit rules — pure, deterministic take-profit / stop-loss decision engine.
 *
 * Given an open position, the current price, the current wall-clock (passed
 * IN — never read here) and a static exit config, `evaluateExit` returns the
 * exit decisions that fire on this tick.
 *
 * SCOPE. This module proposes; it does not act. A decision is a *description*
 * of an exit that the configured rules say is now due. Turning one into an
 * order is the caller's job, and every such caller is expected to route it
 * through the app's existing approval path rather than acting on it directly.
 * Nothing here touches a wallet, a signer, a venue or the database.
 *
 * WHY LOCAL RULES. Venue-native bracket orders already cover Hyperliquid perps
 * (`src/tools/hyperliquid/exchange.ts` attaches reduce-only `tpsl` children at
 * entry). Spot/AMM holdings have no such venue-side trigger: once a swap
 * settles, nothing is watching it. This engine is the venue-agnostic half —
 * it works off a price and a cost basis, so it applies anywhere a position can
 * be priced.
 *
 * Design constraints, each asserted by tests:
 *   - PURE: no I/O, no Date.now(), no randomness. Same inputs → same output,
 *     and neither the position nor the config is mutated.
 *   - TOTAL: it never throws. A non-finite or non-positive price or entry, a
 *     malformed ladder, or a fully-consumed position all yield `[]` — a
 *     documented "do nothing" rather than a crash — so one bad price tick can
 *     never take down the loop that calls it.
 *
 * Rule priority (capital preservation first):
 *   1. stop_loss     — decisive full exit of the remaining position.
 *   2. trailing_stop — full exit, but only once the ladder is in profit
 *                      (at least one take-profit rung consumed).
 *   3. take_profit   — partial exits per crossed ladder rung; several rungs
 *                      may fire on one tick; the cumulative sold fraction is
 *                      clamped so it can never exceed the whole position.
 *   4. time_stop     — flat-and-dead rotation, only if nothing above fired.
 *
 * Fractions are always expressed relative to the ORIGINAL position size, so a
 * caller holding a cost-basis ledger (see `proj_pnl_lots`) can mark rungs
 * consumed and subtract fractions without re-deriving token amounts.
 */

export interface Position {
  /** Token address or symbol — an opaque id, never parsed here. */
  readonly token: string;
  /** Cost basis per token, USD. Must be > 0 for any rule to fire. */
  readonly entryPriceUsd: number;
  /** Current holding size in tokens. */
  readonly amountTokens: number;
  /** Running high-water price seen since entry (>= entryPriceUsd). */
  readonly peakPriceUsd: number;
  /** Epoch ms when the position opened. */
  readonly openedAtMs: number;
  /** Indices of ladder rungs already sold — this is what makes exits idempotent. */
  readonly consumedRungs: readonly number[];
}

export interface TakeProfitRung {
  /** Price multiple vs entry that arms this rung (e.g. 2 = +100%). */
  readonly multiple: number;
  /** Fraction (0..1) of the ORIGINAL position to sell at this rung. */
  readonly sellFraction: number;
}

export interface ExitConfig {
  /** Take-profit ladder, ascending by `multiple`. */
  readonly takeProfitLadder: readonly TakeProfitRung[];
  /** Fractional drawdown from entry that triggers a full stop (e.g. 0.35). */
  readonly stopLossPct: number;
  /**
   * Fractional drawdown from peak that trails out the remainder once the
   * ladder is in profit. Omitted / undefined disables trailing entirely.
   */
  readonly trailingStopPct?: number;
  /** Minutes of flat-and-dead price action before a time-stop rotation. */
  readonly timeStopMinutes: number;
  /** Half-width of the "flat" band around entry (e.g. 0.15 = ±15%). */
  readonly timeStopFlatBandPct: number;
}

export type ExitReasonKind = "stop_loss" | "trailing_stop" | "take_profit" | "time_stop";

export interface ExitDecision {
  readonly kind: ExitReasonKind;
  /** Fraction of the ORIGINAL position this rule says to sell now, in (0..1]. */
  readonly sellFraction: number;
  /** Set for take_profit so the caller can mark the rung consumed. */
  readonly rungIndex?: number;
  /** Human-readable explanation, e.g. "Hit +100% take-profit rung (2x)". */
  readonly reason: string;
}

/** True for a real, strictly-positive number. */
function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * The ladder as a safe array. Types are compile-time only and this module is
 * load-bearing for a background loop, so a config that arrives malformed at
 * runtime degrades to "no ladder" instead of throwing on iteration.
 */
function ladderOf(config: ExitConfig): readonly TakeProfitRung[] {
  return Array.isArray(config.takeProfitLadder) ? config.takeProfitLadder : [];
}

/** The consumed-rung indices as a safe array, for the same reason. */
function consumedRungsOf(position: Position): readonly number[] {
  return Array.isArray(position.consumedRungs) ? position.consumedRungs : [];
}

/**
 * Fraction of the ORIGINAL position already sold, summed from the ladder
 * sellFractions at the consumed rung indices. Out-of-range, duplicate and
 * non-integer indices are ignored so a malformed `consumedRungs` cannot
 * corrupt the remaining-capacity math.
 */
function consumedFraction(position: Position, config: ExitConfig): number {
  const ladder = ladderOf(config);
  const seen = new Set<number>();
  let total = 0;

  for (const idx of consumedRungsOf(position)) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= ladder.length || seen.has(idx)) {
      continue;
    }
    const rung = ladder[idx];
    if (rung === undefined) {
      continue;
    }
    seen.add(idx);
    if (Number.isFinite(rung.sellFraction) && rung.sellFraction > 0) {
      total += rung.sellFraction;
    }
  }

  return total;
}

/** Remaining sellable fraction of the original position, clamped to [0, 1]. */
function remainingFraction(position: Position, config: ExitConfig): number {
  const remaining = 1 - consumedFraction(position, config);
  if (!Number.isFinite(remaining)) {
    return 0;
  }
  return Math.min(1, Math.max(0, remaining));
}

/**
 * Decide which exits are due for `position` at `currentPriceUsd` and `nowMs`.
 *
 * Returns `[]` when nothing fires and when the inputs are unusable. Callers
 * should treat a non-empty result as a proposal to be surfaced for approval,
 * never as an instruction already authorised.
 */
export function evaluateExit(
  position: Position,
  currentPriceUsd: number,
  nowMs: number,
  config: ExitConfig,
): ExitDecision[] {
  // --- Defensive totality: a bad tick must never throw or over-sell. ---
  if (!isPositiveFinite(currentPriceUsd) || !isPositiveFinite(position.entryPriceUsd)) {
    return [];
  }

  const { entryPriceUsd } = position;
  const remaining = remainingFraction(position, config);

  // Nothing left to sell → no exit is meaningful.
  if (remaining <= 0) {
    return [];
  }

  // --- 1. stop_loss (highest priority: capital preservation). ---
  if (Number.isFinite(config.stopLossPct)) {
    const stopPrice = entryPriceUsd * (1 - config.stopLossPct);
    if (currentPriceUsd <= stopPrice) {
      const lossPct = (1 - currentPriceUsd / entryPriceUsd) * 100;
      return [
        {
          kind: "stop_loss",
          sellFraction: remaining,
          reason: `Stop-loss hit: ${lossPct.toFixed(1)}% below entry (threshold ${(
            config.stopLossPct * 100
          ).toFixed(1)}%)`,
        },
      ];
    }
  }

  // --- 2. trailing_stop: armed only once at least one rung is consumed. ---
  if (
    consumedRungsOf(position).length > 0 &&
    config.trailingStopPct !== undefined &&
    Number.isFinite(config.trailingStopPct) &&
    isPositiveFinite(position.peakPriceUsd)
  ) {
    const trailPrice = position.peakPriceUsd * (1 - config.trailingStopPct);
    if (currentPriceUsd <= trailPrice) {
      const dropPct = (1 - currentPriceUsd / position.peakPriceUsd) * 100;
      return [
        {
          kind: "trailing_stop",
          sellFraction: remaining,
          reason: `Trailing stop hit: ${dropPct.toFixed(1)}% below peak (threshold ${(
            config.trailingStopPct * 100
          ).toFixed(1)}%)`,
        },
      ];
    }
  }

  // --- 3. take_profit: emit every newly-crossed rung, ascending, clamped. ---
  const takeProfits: ExitDecision[] = [];
  const consumed = new Set<number>(consumedRungsOf(position));
  let cumulative = consumedFraction(position, config);

  ladderOf(config).forEach((rung, index) => {
    if (consumed.has(index)) {
      return;
    }
    if (!Number.isFinite(rung.multiple) || !Number.isFinite(rung.sellFraction)) {
      return;
    }
    if (currentPriceUsd < entryPriceUsd * rung.multiple) {
      return;
    }
    const capacity = 1 - cumulative;
    if (capacity <= 0) {
      return; // Fully allocated — nothing left for this or any later rung.
    }
    const sellFraction = Math.min(rung.sellFraction, capacity);
    if (sellFraction <= 0) {
      return;
    }
    cumulative += sellFraction;
    const gainPct = (rung.multiple - 1) * 100;
    takeProfits.push({
      kind: "take_profit",
      sellFraction,
      rungIndex: index,
      reason: `Hit +${gainPct.toFixed(0)}% take-profit rung (${rung.multiple}x)`,
    });
  });

  if (takeProfits.length > 0) {
    return takeProfits;
  }

  // --- 4. time_stop: flat-and-dead rotation, only if nothing above fired. ---
  if (
    Number.isFinite(config.timeStopMinutes) &&
    Number.isFinite(config.timeStopFlatBandPct) &&
    Number.isFinite(nowMs) &&
    Number.isFinite(position.openedAtMs)
  ) {
    const elapsedMs = nowMs - position.openedAtMs;
    const bandDistance = Math.abs(currentPriceUsd / entryPriceUsd - 1);
    if (
      elapsedMs >= config.timeStopMinutes * 60_000 &&
      bandDistance <= config.timeStopFlatBandPct
    ) {
      const driftPct = (currentPriceUsd / entryPriceUsd - 1) * 100;
      return [
        {
          kind: "time_stop",
          sellFraction: remaining,
          reason: `Time-stop: flat ${driftPct.toFixed(
            1,
          )}% from entry after ${config.timeStopMinutes}m`,
        },
      ];
    }
  }

  return [];
}
