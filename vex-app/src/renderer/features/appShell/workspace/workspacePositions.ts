/**
 * Display-only derivations over the positions DTO for the workspace chrome
 * (top-bar uPnL, watchlist). Numeric conversion here is a RENDERING adapter
 * only — canonical decimal strings remain authoritative at every IPC/policy
 * boundary; nothing here feeds signing or a trade decision.
 */

import type { HyperliquidPositionDto } from "@shared/schemas/hyperliquid.js";

/** Sum unrealized PnL across positions. Non-finite cells are skipped, never
 * silently coerced to 0 into a total the user reads as truth. */
export function sumUnrealizedPnl(
  positions: readonly HyperliquidPositionDto[],
): number {
  return positions.reduce((acc, position) => {
    const value = Number(position.unrealizedPnl);
    return Number.isFinite(value) ? acc + value : acc;
  }, 0);
}

/** Signed USD display for a derived figure (top-bar uPnL). */
export function formatSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const magnitude = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${magnitude}`;
}

/** Direction tone class for a signed figure (long green / short rose). */
export function directionToneClass(value: number): string {
  return value < 0 ? "text-[var(--vex-short)]" : "text-[var(--vex-long)]";
}

/** The market a coin symbol maps to in the open book, or null. */
export function findPositionByCoin(
  positions: readonly HyperliquidPositionDto[],
  coin: string | null,
): HyperliquidPositionDto | null {
  if (coin === null) return null;
  return positions.find((position) => position.coin === coin) ?? null;
}
