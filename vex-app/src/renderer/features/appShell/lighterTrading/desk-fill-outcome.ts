/**
 * What a desk order came to. "Order sent." is main's word that the order was
 * submitted; the fill is Lighter's. The first fill on that market to land
 * after the send is the one the ticket reports.
 */

import type { LighterTradingFill } from "@shared/schemas/lighter-trading.js";
import { formatDecimalString } from "./format.js";

export interface AwaitedFill {
  readonly marketId: number;
  /** When the card resolved, in ms; fills stamped before it belong to earlier orders. */
  readonly sentAt: number;
  /** Text that follows the fill sentence, such as the protection note. */
  readonly suffix: string;
}

/** Lighter stamps fills in seconds or milliseconds depending on the endpoint. */
function fillTimeMs(fill: LighterTradingFill): number {
  return fill.timestamp >= 1_000_000_000_000 ? fill.timestamp : fill.timestamp * 1_000;
}

/** The newest fill on the market since the send, or null while none has landed. */
export function fillSince(
  fills: readonly LighterTradingFill[],
  awaited: AwaitedFill,
): LighterTradingFill | null {
  // Provider and desk clocks can disagree by a little; a fill a few seconds
  // "before" the send is still this order's.
  const floor = awaited.sentAt - 5_000;
  return fills.find((fill) => fill.marketId === awaited.marketId && fillTimeMs(fill) >= floor) ?? null;
}

export function fillSentence(fill: LighterTradingFill): string {
  return `Filled ${formatDecimalString(fill.size)} ${fill.symbol} at ${formatDecimalString(fill.price)}.`;
}
