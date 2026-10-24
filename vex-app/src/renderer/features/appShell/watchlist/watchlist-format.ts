/**
 * Display helpers for the Watchlist page (F01). Prices stay the engine's exact
 * decimal text; these only shorten them for the eye and word the states.
 */

import { alertChainName, alertConditionWords, formatAlertPrice } from "@shared/alerts-copy.js";
import type { PriceAlertCondition, PriceAlertDto, WatchlistItemDto } from "@shared/schemas/alerts.js";

export { alertChainName, alertConditionWords, formatAlertPrice };

export const CONDITION_OPTIONS: ReadonlyArray<{ readonly value: PriceAlertCondition; readonly label: string }> = [
  { value: "above", label: "Price above" },
  { value: "below", label: "Price below" },
  { value: "rises_pct", label: "Rises by %" },
  { value: "falls_pct", label: "Falls by %" },
];

/** "$3500.25", or the reason there is no price. */
export function itemPriceText(item: WatchlistItemDto): string {
  if (item.quote !== null) return `$${formatAlertPrice(item.quote.priceUsd)}`;
  return item.priceStatus === "unavailable" ? "Price unavailable" : "No price yet";
}

/** "+1.25%" / "-0.40%", or "n/a" when the pool cannot say it for this token. */
export function itemChangeText(item: WatchlistItemDto): string {
  const change = item.quote?.change24hPct ?? null;
  if (change === null) return "n/a";
  return `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;
}

/** "WETH on Base, above $4000" for an alert row. */
export function alertRowWords(alert: PriceAlertDto): string {
  return `${alert.label} on ${alertChainName(alert.chain)}, ${alertConditionWords(alert.condition, alert.value)}`;
}

/** "14:02 UTC, 24 Oct" for a fired time. */
export function firedTimeText(iso: string): string {
  const at = new Date(iso);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  const day = at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${hh}:${mm} UTC, ${day}`;
}

/** The value field's hint for a condition. */
export function valueHint(condition: PriceAlertCondition): string {
  return condition === "above" || condition === "below" ? "USD price, e.g. 4000" : "Percent, e.g. 5";
}
