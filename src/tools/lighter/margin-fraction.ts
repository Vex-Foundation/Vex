/**
 * The one owner of Lighter's initial-margin-fraction unit.
 *
 * Lighter expresses the SAME concept in three shapes, and they were measured
 * live on 2026-09-10 rather than read from documentation:
 *
 *  - the wire and the market endpoint use a 10000-scale INTEGER
 *    (`default_initial_margin_fraction: 5000` is 2x leverage);
 *  - the trade endpoint uses the same 10000-scale integer;
 *  - the ACCOUNT endpoint reports a position's `initial_margin_fraction` as a
 *    PERCENT STRING ("50.00"), which is the same 5000 written differently.
 *
 * The vendor's own SDK carries the inconsistency too: `update_leverage` takes a
 * leverage, `sign_update_leverage` takes a fraction, and their example file
 * (`examples/margin/margin_eth_20x_cross_http.py`) says in a comment that the
 * two were kept inconsistent for backwards compatibility. So the conversion has
 * to live SOMEWHERE, and this module is that somewhere: the 10000-scale integer
 * is the canonical Vex unit, every scale change happens here, and nothing else
 * multiplies or divides by 100 or by 10000.
 *
 * Integer arithmetic only. Leverage and margin are money terms, and a float
 * that lands a tick low is a position the user did not consent to.
 */

import { ErrorCodes, VexError } from "../../errors.js";

/**
 * Lighter's `MarginFractionTick`: the integer that means "the whole position is
 * margin", so 1x leverage. Table-tested against the pinned lighter-go artifact
 * in `src/__tests__/vex-agent/tools/lighter-wire-codes.test.ts`.
 */
export const LIGHTER_MARGIN_FRACTION_TICK = 10_000;

/**
 * The smallest fraction the provider accepts: 10000x, one tick of margin.
 *
 * Exported because it is also the LOWER BOUND OF THE DURABLE RANGE: the
 * `lighter_fills.initial_margin_fraction_before` CHECK (migration 162) admits
 * exactly `MINIMUM_INITIAL_MARGIN_FRACTION..LIGHTER_MARGIN_FRACTION_TICK`, and
 * the writer that normalizes a provider value against it must read the bound
 * from this owner rather than spelling a 1 of its own.
 */
export const MINIMUM_INITIAL_MARGIN_FRACTION = 1;

/** Two decimals is exactly what the account endpoint emits ("50.00"). */
const PERCENT_DECIMALS = 2;
const PERCENT_SCALE = 100;

export type LighterMarginMode = "cross" | "isolated";

/**
 * Vex's spelling of a margin mode to the integer the signer puts on the wire.
 * Table-tested against `txtypes.CrossMargin` and `txtypes.IsolatedMargin` in
 * the pinned module, in both directions.
 */
export const LIGHTER_MARGIN_MODE_WIRE: Readonly<Record<LighterMarginMode, 0 | 1>> = {
  cross: 0,
  isolated: 1,
};

/**
 * A provider or durable margin-mode integer to Vex's spelling.
 *
 * A mode Vex does not know is a refusal, never a fallback to cross: cross and
 * isolated have different liquidation behavior, and guessing wrong would put a
 * wrong sentence in front of the user before they consent.
 */
export function marginModeFromWire(value: number): LighterMarginMode {
  for (const [mode, wire] of Object.entries(LIGHTER_MARGIN_MODE_WIRE)) {
    if (value === wire) return mode as LighterMarginMode;
  }
  throw invalidProviderValue(
    `Lighter reported an unknown margin mode (${String(value)}).`,
  );
}

/**
 * The account endpoint's percent string to the canonical 10000-scale integer.
 *
 * "50.00" -> 5000, "2.00" -> 200, "33.33" -> 3333, "100" -> 10000.
 *
 * Parsed as text, never through `Number`: the value decides what the user is
 * told their current leverage is, and a float round-trip of "33.33" is not
 * exactly 3333. A missing, malformed, zero, negative or above-100 value is a
 * refusal rather than a default, because there is no safe default for "how much
 * margin does this position hold".
 */
export function positionInitialMarginFractionToProviderScale(percent: string): number {
  if (typeof percent !== "string") {
    throw invalidProviderValue("Lighter reported a non-textual initial margin fraction.");
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(percent.trim());
  if (match === null) {
    throw invalidProviderValue(
      `Lighter reported an initial margin fraction Vex cannot read exactly ("${percent}").`,
    );
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(PERCENT_DECIMALS, "0"));
  if (!Number.isSafeInteger(whole)) {
    throw invalidProviderValue(
      `Lighter reported an initial margin fraction outside the readable range ("${percent}").`,
    );
  }
  const scaled = whole * PERCENT_SCALE + fraction;
  if (scaled < MINIMUM_INITIAL_MARGIN_FRACTION || scaled > LIGHTER_MARGIN_FRACTION_TICK) {
    throw invalidProviderValue(
      `Lighter reported an initial margin fraction outside 0 to 100 percent ("${percent}").`,
    );
  }
  return scaled;
}

/**
 * A whole-number leverage to the initial margin fraction that produces it,
 * ROUNDED UP.
 *
 * 3 -> 3334 (not 3333), 50 -> 200, 1 -> 10000.
 *
 * The rounding direction is a safety decision, not a style one. The vendor SDK
 * truncates (`imf = int(10_000 / leverage)`, `signer_client.py:1352`), which
 * hands the account slightly MORE leverage than the number the user typed;
 * rounding up hands it slightly less. Never more than the human consented to.
 */
export function leverageToInitialMarginFraction(leverage: number): number {
  if (!Number.isSafeInteger(leverage) || leverage < 1 || leverage > LIGHTER_MARGIN_FRACTION_TICK) {
    throw invalidCallerValue(
      `Leverage must be a whole number from 1 through ${LIGHTER_MARGIN_FRACTION_TICK}.`,
    );
  }
  return Math.floor((LIGHTER_MARGIN_FRACTION_TICK + leverage - 1) / leverage);
}

/**
 * The canonical integer to the leverage a human reads, TRUNCATED to two
 * decimals.
 *
 * 5000 -> "2.00", 200 -> "50.00", 3334 -> "2.99".
 *
 * Truncated rather than rounded for the same reason the conversion above rounds
 * up: 3334 is 2.9994x, and displaying "3.00x" would tell the user they have
 * leverage the exchange will not give them.
 */
export function initialMarginFractionToLeverageDisplay(imf: number): string {
  if (
    !Number.isInteger(imf)
    || imf < MINIMUM_INITIAL_MARGIN_FRACTION
    || imf > LIGHTER_MARGIN_FRACTION_TICK
  ) {
    throw invalidCallerValue(
      `An initial margin fraction must be a whole number from ${MINIMUM_INITIAL_MARGIN_FRACTION} through ${LIGHTER_MARGIN_FRACTION_TICK}.`,
    );
  }
  const scaled = Math.floor((LIGHTER_MARGIN_FRACTION_TICK * PERCENT_SCALE) / imf);
  const whole = Math.floor(scaled / PERCENT_SCALE);
  const fraction = scaled % PERCENT_SCALE;
  return `${whole}.${String(fraction).padStart(PERCENT_DECIMALS, "0")}`;
}

function invalidProviderValue(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_RESPONSE,
    message,
    "Re-read the Lighter account or market before acting on its margin terms.",
  );
}

function invalidCallerValue(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Choose a leverage inside the market's own range and try again.",
  );
}
