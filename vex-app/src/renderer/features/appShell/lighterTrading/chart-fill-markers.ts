import type { SeriesMarker, UTCTimestamp } from "lightweight-charts";
import type { LighterTradingFill } from "@shared/schemas/lighter-trading.js";

/** Index of the latest bar at or before `time`, or -1 when none is loaded. */
function barIndexAt(barTimes: readonly number[], time: number): number {
  let low = 0;
  let high = barTimes.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (barTimes[middle]! <= time) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/**
 * One arrow per bar and side: fills inside the same bar collapse into a single
 * marker. The arrows carry no text, so a busy account never buries its own
 * candles under labels; the sizes and prices live in the trade history.
 */
export function fillMarkers(
  fills: readonly LighterTradingFill[],
  barTimes: readonly number[],
  colors: { readonly positive: string; readonly negative: string },
): SeriesMarker<UTCTimestamp>[] {
  if (fills.length === 0 || barTimes.length === 0) return [];
  const buckets = new Map<string, { time: number; side: "buy" | "sell" }>();
  for (const fill of fills) {
    const size = Number(fill.size);
    if (!Number.isFinite(size) || size <= 0) continue;
    const seconds = fill.timestamp >= 1_000_000_000_000 ? Math.floor(fill.timestamp / 1_000) : fill.timestamp;
    const index = barIndexAt(barTimes, seconds);
    if (index < 0) continue;
    const time = barTimes[index]!;
    buckets.set(`${time}:${fill.side}`, { time, side: fill.side });
  }
  return [...buckets.values()]
    .sort((left, right) => left.time - right.time || (left.side === "buy" ? -1 : 1))
    .map((bucket) => ({
      id: `fill:${bucket.time}:${bucket.side}`,
      time: bucket.time as UTCTimestamp,
      position: bucket.side === "buy" ? "belowBar" : "aboveBar",
      shape: bucket.side === "buy" ? "arrowUp" : "arrowDown",
      color: bucket.side === "buy" ? colors.positive : colors.negative,
    }));
}
