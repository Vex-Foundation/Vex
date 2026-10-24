/**
 * The words a fired price alert is shown in (F01), shared by main's OS
 * notification and the renderer's in-app notice so the two never disagree.
 *
 * Pure: no Electron, no DOM. Prices stay the exact decimal text the engine
 * recorded; only very long fractions are cut for display, never rounded up.
 */

import { chainDisplayBySlug } from "./chains/display.js";
import type { PriceAlertCondition } from "./schemas/alerts.js";

/** The OS notification body while the vault is locked: no token, no price. */
export const LOCKED_PRICE_ALERT_BODY = "A price alert fired. Unlock Vex to see it.";

/** The OS notification title. */
export const PRICE_ALERT_TITLE = "Vex price alert";

/** Fraction digits shown for a price at or above 1; below 1, enough to see it move. */
const MAX_FRACTION_DIGITS = 6;
const MAX_SMALL_FRACTION_DIGITS = 10;

/** "3500.123456789" -> "3500.123456"; "0.000012345678901" -> "0.0000123456"; integers as they are. */
export function formatAlertPrice(decimal: string): string {
  const [whole = decimal, fraction] = decimal.split(".");
  if (fraction === undefined || fraction === "") return whole;
  const cap = whole === "0" ? MAX_SMALL_FRACTION_DIGITS : MAX_FRACTION_DIGITS;
  const kept = fraction.slice(0, cap).replace(/0+$/, "");
  return kept === "" ? whole : `${whole}.${kept}`;
}

/** The chain as people say it: "Base", "Solana", else the slug as written. */
export function alertChainName(slug: string): string {
  if (slug === "solana") return "Solana";
  return chainDisplayBySlug(slug).name;
}

/** The condition in words, with its level: "above $4000", "falls 5%". */
export function alertConditionWords(condition: PriceAlertCondition, value: string): string {
  switch (condition) {
    case "above":
      return `above $${formatAlertPrice(value)}`;
    case "below":
      return `below $${formatAlertPrice(value)}`;
    case "rises_pct":
      return `rises ${formatAlertPrice(value)}%`;
    case "falls_pct":
      return `falls ${formatAlertPrice(value)}%`;
  }
}

export interface FiredAlertWords {
  readonly label: string;
  readonly chain: string;
  readonly condition: PriceAlertCondition;
  readonly value: string;
  readonly triggeredPrice: string;
  readonly note: string | null;
}

/**
 * One sentence for a fired alert: "WETH on Base went above $4000, at
 * $4012.5." A percentage alert names the move: "WETH on Base rose 5%, at
 * $3675." The note, when there is one, follows on its own.
 */
export function firedAlertSentence(alert: FiredAlertWords): string {
  const where = `${alert.label} on ${alertChainName(alert.chain)}`;
  const at = `$${formatAlertPrice(alert.triggeredPrice)}`;
  const level = formatAlertPrice(alert.value);
  const head = (() => {
    switch (alert.condition) {
      case "above":
        return `${where} went above $${level}, at ${at}.`;
      case "below":
        return `${where} went below $${level}, at ${at}.`;
      case "rises_pct":
        return `${where} rose ${level}%, at ${at}.`;
      case "falls_pct":
        return `${where} fell ${level}%, at ${at}.`;
    }
  })();
  return alert.note === null || alert.note.trim() === "" ? head : `${head} Note: ${alert.note.trim()}`;
}
