/**
 * How this policy REFUSES, in one place.
 *
 * Every gate in this folder ends the same way when it says no: a
 * `MORPHO_MARKET_POLICY_VIOLATION` naming the failing predicate, plus the one
 * hint that matters to whoever reads it - that nothing was signed and that
 * retrying will produce the same answer. Keeping the hint here stops the wording
 * drifting between gates, which is how a refusal starts reading like a transient
 * failure and gets retried in a loop.
 */

import { formatUnits } from "viem";

import { VexError, ErrorCodes } from "../../../../errors.js";

export const NOTHING_HAPPENED_HINT =
  "Nothing was approved, signed or sent. This is a policy refusal rather than a transient failure, so retrying the "
  + "same market produces the same answer.";

export function policyViolation(message: string, hint: string): never {
  throw new VexError(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION, message, hint);
}

/** A WAD fixed-point number as a plain decimal string, trailing zeros trimmed. */
export function formatWad(value: bigint): string {
  const text = formatUnits(value, 18);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** The zero address, which a market or an oracle leg uses to mean "none". */
export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
