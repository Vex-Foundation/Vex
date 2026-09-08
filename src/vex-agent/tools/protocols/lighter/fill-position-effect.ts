/**
 * WHAT ONE FILL DID TO THE ACCOUNT'S OWN POSITION, classified from Lighter's
 * own fields and nothing else.
 *
 * The campaign API (Superboard) needs a fill's type - open or close - and its
 * realized PnL. Neither is a number Vex may compute: an entry-minus-exit PnL
 * of our own would disagree with the venue's the moment funding, fees or a
 * partial close enters, and a type derived from our order intent would call a
 * reduce-only order that missed an "open". So both come from the trade record:
 * the position size the account held BEFORE the fill, whether the fill carried
 * that position through zero, and the realized PnL Lighter attributes to the
 * side the account was on. The only thing this module does is NAME the
 * transition those fields already describe.
 *
 * ## Why it is its own module
 *
 * Two owners need the same classification and must never disagree about it:
 * the fill ledger (`agentscan-activity.ts`), which stores it once and never
 * recomputes it, and the read projections (`projectors.ts`), which show it to
 * a human reading the trading panel. A second implementation in either place
 * would be a second source of truth for a money-path label.
 *
 * ## Established once, never recomputed
 *
 * A public `recentTrades` row carries the position sizes before the trade but
 * neither the sign-changed flag nor the account PnL, so a fill first seen
 * publicly has NO effect at all - not "unknown" stored as a fact, but NULL,
 * the absence of knowledge. When an authenticated observation later supplies
 * the missing fields, the effect is established once and is immutable from
 * then on. {@link readLighterAccountFillFacts} is the gate: it returns null
 * unless every field the classification rests on is present.
 *
 * ## Decimal-safe
 *
 * Every comparison here is exact bigint arithmetic on the provider's decimal
 * strings. A position size through a double has already lost the digits that
 * decide whether a fill closed a position or left dust behind it.
 */

import type { LighterTrade } from "@tools/lighter/types.js";

/**
 * What a fill did to the account's position.
 *
 * `unknown` is NOT "we have no data" - that is the null return of
 * {@link readLighterAccountFillFacts}. It is the narrower and rarer case where
 * the fields ARE present and contradict each other (the fill is larger than
 * the position it opposed, yet the provider reports no sign change), which is
 * a provider-side fact we refuse to smooth over.
 */
export type LighterPositionEffect = "open" | "increase" | "reduce" | "close" | "flip" | "unknown";

/** Every effect, for exhaustive table tests and column checks. */
export const LIGHTER_POSITION_EFFECTS: readonly LighterPositionEffect[] = [
  "open",
  "increase",
  "reduce",
  "close",
  "flip",
  "unknown",
];

/**
 * The account's own view of one trade record: the maker or taker "before"
 * fields chosen by the role the ACCOUNT played, and the ask or bid realized
 * PnL chosen by the SIDE the account traded.
 *
 * Reading the wrong half reports the counterparty's position and the
 * counterparty's realized PnL as the user's own, which is why the selection
 * lives here rather than at each call site.
 */
export interface LighterAccountFillFacts {
  /** Signed decimal string: negative while the account was short. */
  readonly positionSizeBefore: string;
  /** TRUE when this fill carried the position through zero. */
  readonly positionSignChanged: boolean;
  /** Signed decimal string; null when the provider reported none. */
  readonly entryQuoteBefore: string | null;
  /**
   * Lighter's own realized PnL for this account, on this fill. Signed decimal
   * string, "0" on a fill that realized nothing. Never computed here.
   */
  readonly accountPnl: string;
  /** Initial margin fraction before the fill, on the provider's 10000 scale. */
  readonly initialMarginFractionBefore: number | null;
}

/**
 * Which half of the trade record speaks for this account.
 *
 * `role` is maker or taker; `side` is buy or sell. They are independent: an
 * account can be the maker on either side of the book.
 */
export function readLighterAccountFillFacts(input: {
  readonly trade: LighterTrade;
  readonly role: "maker" | "taker";
  readonly side: "buy" | "sell";
}): LighterAccountFillFacts | null {
  const { trade, role, side } = input;
  const maker = role === "maker";
  const positionSizeBefore = signedDecimal(
    maker ? trade.maker_position_size_before : trade.taker_position_size_before,
  );
  const positionSignChanged = maker ? trade.maker_position_sign_changed : trade.taker_position_sign_changed;
  // A SELL is the ask side, and Lighter attributes the realized PnL of a
  // reducing long to `ask_account_pnl`; a buy is the bid side.
  const accountPnl = signedDecimal(side === "sell" ? trade.ask_account_pnl : trade.bid_account_pnl);
  if (positionSizeBefore === null || typeof positionSignChanged !== "boolean" || accountPnl === null) {
    // A public trade row. It knows the sizes but not the account, and a
    // classification built on half of it would be a guess wearing a label.
    return null;
  }
  return {
    positionSizeBefore,
    positionSignChanged,
    entryQuoteBefore: signedDecimal(
      maker ? trade.maker_entry_quote_before : trade.taker_entry_quote_before,
    ),
    accountPnl,
    initialMarginFractionBefore: marginFraction(
      maker ? trade.maker_initial_margin_fraction_before : trade.taker_initial_margin_fraction_before,
    ),
  };
}

/**
 * The classification itself.
 *
 * `fillBaseSize` is the trade's own unsigned base size; the account's side
 * gives it its sign. A flip is ONE fill and is counted once: it is not
 * reported as a close plus an open, which would double the volume it moved.
 */
export function classifyLighterPositionEffect(input: {
  readonly positionSizeBefore: string;
  readonly positionSignChanged: boolean;
  readonly fillBaseSize: string;
  readonly side: "buy" | "sell";
}): LighterPositionEffect {
  const before = parseSignedDecimal(input.positionSizeBefore);
  const size = parseSignedDecimal(input.fillBaseSize);
  if (before === null || size === null || size.units < 0n) return "unknown";

  const scale = Math.max(before.decimals, size.decimals);
  const beforeUnits = rescale(before, scale);
  const sizeUnits = rescale(size, scale);
  const delta = input.side === "buy" ? sizeUnits : -sizeUnits;

  if (beforeUnits === 0n) {
    // Nothing was held. A zero-size fill would move nothing at all, and
    // calling that an open would be a claim about a position that does not
    // exist.
    return delta === 0n ? "unknown" : "open";
  }
  if (delta === 0n) return "unknown";

  // THE MAGNITUDES DECIDE; THE PROVIDER'S FLAG HAS TO AGREE WITH THEM.
  // Measured live on 2026-09-08 (Robinhood Chain, a 0.0050 long sold whole):
  // Lighter reports `position_sign_changed: true` when the position goes to
  // ZERO as well as when it crosses to the other side, so the flag alone
  // cannot tell a close from a flip. A flag that contradicts the arithmetic
  // (a reduce or an increase said to have changed sign, a flip said not to)
  // makes neither statement a fact, and neither is reported as one.
  const sameDirection = (beforeUnits > 0n) === (delta > 0n);
  if (sameDirection) return input.positionSignChanged ? "unknown" : "increase";

  const magnitudeBefore = beforeUnits < 0n ? -beforeUnits : beforeUnits;
  const magnitudeDelta = delta < 0n ? -delta : delta;
  if (magnitudeDelta < magnitudeBefore) return input.positionSignChanged ? "unknown" : "reduce";
  if (magnitudeDelta === magnitudeBefore) return input.positionSignChanged ? "close" : "unknown";
  return input.positionSignChanged ? "flip" : "unknown";
}

/**
 * The campaign's own two-value type, from the effect.
 *
 * open and increase add exposure; reduce, close and flip take it off, and a
 * flip's realized PnL is the close half of it. `unknown` and a null effect are
 * both reported as unknown rather than defaulted into either bucket.
 */
export function lighterCampaignTradeType(
  effect: LighterPositionEffect | null,
): "open" | "close" | "unknown" {
  switch (effect) {
    case "open":
    case "increase":
      return "open";
    case "reduce":
    case "close":
    case "flip":
      return "close";
    default:
      return "unknown";
  }
}

const SIGNED_DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function signedDecimal(value: unknown): string | null {
  return typeof value === "string" && SIGNED_DECIMAL.test(value) ? value : null;
}

function marginFraction(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

interface SignedDecimal {
  readonly units: bigint;
  readonly decimals: number;
}

/** Exact, never a float: `-1.25` becomes -125 units at two decimals. */
export function parseSignedDecimal(value: string): SignedDecimal | null {
  if (!SIGNED_DECIMAL.test(value)) return null;
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(`${whole}${fraction}`);
  return { units: negative ? -units : units, decimals: fraction.length };
}

function rescale(value: SignedDecimal, decimals: number): bigint {
  return value.units * 10n ** BigInt(decimals - value.decimals);
}
