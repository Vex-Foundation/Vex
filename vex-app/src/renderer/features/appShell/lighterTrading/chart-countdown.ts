import type { LighterTradingResolution } from "@shared/schemas/lighter-trading.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// The Unix epoch fell on a Thursday; Lighter's weekly bars open on Monday.
const WEEK_OFFSET_MS = 4 * DAY_MS;

export const CHART_RESOLUTION_MS: Record<LighterTradingResolution, number> = {
  "1m": MINUTE_MS,
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "30m": 30 * MINUTE_MS,
  "1h": HOUR_MS,
  "4h": 4 * HOUR_MS,
  "12h": 12 * HOUR_MS,
  "1d": DAY_MS,
  "1w": 7 * DAY_MS,
};

/** Time left in the bar that is open at `now`, as mm:ss or h:mm:ss. */
export function candleCountdown(resolution: LighterTradingResolution, now: number): string {
  const size = CHART_RESOLUTION_MS[resolution];
  const aligned = resolution === "1w" ? now - WEEK_OFFSET_MS : now;
  const remaining = size - (aligned % size);
  const hours = Math.floor(remaining / HOUR_MS);
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((remaining % MINUTE_MS) / 1_000);
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}
