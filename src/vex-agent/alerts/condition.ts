/**
 * Price alert conditions (F01): what a user value means, the absolute level a
 * new alert is stored with, and the one rule every pass fires on.
 *
 * EXACT DECIMALS ONLY. The value is user (or model) input and the price is
 * provider input; both go through the bounded decimal primitives the
 * `token_price` wake watch already uses, never through `Number`.
 *
 * STORED LEVEL. A percentage alert is turned into its absolute level once, at
 * creation: `reference * (100 + pct) / 100` for a rise, `reference * (100 -
 * pct) / 100` for a fall, truncated to 20 fractional digits by
 * `divideBoundedDecimals`. The poller then compares one price against one
 * level with the same "touching counts" rule as the wake watch, so the page,
 * the tool and the poller can never disagree about what fires.
 */

import {
  compareBoundedDecimals,
  divideBoundedDecimals,
  formatBoundedDecimal,
  isPositiveDecimal,
  multiplyBoundedDecimals,
  parseBoundedDecimal,
  type BoundedDecimal,
} from "../../tools/dexscreener/token-watch-price/decimal.js";

export const PRICE_ALERT_CONDITIONS = ["above", "below", "rises_pct", "falls_pct"] as const;
export type PriceAlertCondition = (typeof PRICE_ALERT_CONDITIONS)[number];

/** Which side of the stored level fires. */
export type PriceAlertDirection = "above" | "below";

/** The largest move a percentage alert may wait for (Cloud's bound). */
export const MAX_MOVE_PCT = "1000";

/** What a user may type as a value: a plain decimal, at most 15 + 12 digits. */
const VALUE_PATTERN = /^\d{1,15}(?:\.\d{1,12})?$/;

const HUNDRED: BoundedDecimal = { units: 100n, scale: 0 };

export function isPriceAlertCondition(value: unknown): value is PriceAlertCondition {
  return typeof value === "string" && (PRICE_ALERT_CONDITIONS as readonly string[]).includes(value);
}

export function isPercentCondition(condition: PriceAlertCondition): boolean {
  return condition === "rises_pct" || condition === "falls_pct";
}

/**
 * The user's value as an exact decimal, or `null` when it is not one this
 * condition accepts: not a plain positive decimal, a move above
 * {@link MAX_MOVE_PCT}, or a fall of 100% or more (a price cannot fall to zero
 * and stay a price).
 */
export function parseAlertValue(condition: PriceAlertCondition, raw: string): BoundedDecimal | null {
  const trimmed = raw.trim();
  if (!VALUE_PATTERN.test(trimmed)) return null;
  const value = parseBoundedDecimal(trimmed);
  if (value === null || !isPositiveDecimal(value)) return null;
  if (isPercentCondition(condition)) {
    const max = parseBoundedDecimal(MAX_MOVE_PCT);
    if (max === null || compareBoundedDecimals(value, max) > 0) return null;
    if (condition === "falls_pct" && compareBoundedDecimals(value, HUNDRED) >= 0) return null;
  }
  return value;
}

function addToHundred(pct: BoundedDecimal): BoundedDecimal {
  return { units: 100n * 10n ** BigInt(pct.scale) + pct.units, scale: pct.scale };
}

function subtractFromHundred(pct: BoundedDecimal): BoundedDecimal {
  return { units: 100n * 10n ** BigInt(pct.scale) - pct.units, scale: pct.scale };
}

export interface AlertLevel {
  /** The absolute USD level the poller compares against. */
  readonly triggerPrice: BoundedDecimal;
  readonly direction: PriceAlertDirection;
}

/**
 * The level and side a new alert is stored with. `value` must already have
 * passed {@link parseAlertValue} for this condition; `reference` is the price
 * read when the alert is set.
 */
export function alertLevel(
  condition: PriceAlertCondition,
  value: BoundedDecimal,
  reference: BoundedDecimal,
): AlertLevel | null {
  switch (condition) {
    case "above":
      return { triggerPrice: value, direction: "above" };
    case "below":
      return { triggerPrice: value, direction: "below" };
    case "rises_pct": {
      const level = divideBoundedDecimals(multiplyBoundedDecimals(reference, addToHundred(value)), HUNDRED);
      return level === null || !isPositiveDecimal(level) ? null : { triggerPrice: level, direction: "above" };
    }
    case "falls_pct": {
      const level = divideBoundedDecimals(multiplyBoundedDecimals(reference, subtractFromHundred(value)), HUNDRED);
      return level === null || !isPositiveDecimal(level) ? null : { triggerPrice: level, direction: "below" };
    }
  }
}

/** Has `price` reached `level` on `direction`'s side? Touching counts. */
export function alertFires(price: BoundedDecimal, level: BoundedDecimal, direction: PriceAlertDirection): boolean {
  const comparison = compareBoundedDecimals(price, level);
  return direction === "above" ? comparison >= 0 : comparison <= 0;
}

/**
 * A level alert whose level the price has already reached would fire on the
 * first pass: the caller refuses it instead (`already_past`). A move is
 * measured from now, so it can never be already past.
 */
export function alreadyPast(condition: PriceAlertCondition, value: BoundedDecimal, price: BoundedDecimal): boolean {
  if (condition === "above") return alertFires(price, value, "above");
  if (condition === "below") return alertFires(price, value, "below");
  return false;
}

/** Plain notation, no exponent, no trailing zeros: what is stored and shown. */
export function formatAlertDecimal(value: BoundedDecimal): string {
  return formatBoundedDecimal(value);
}
