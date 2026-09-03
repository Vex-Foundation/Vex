/**
 * W2b (SPEC §2.1 item 8) - the honeypot/FoT check that could NOT run.
 *
 * `kyberswap.swap.execute` fails SOFT when the token-api safety check throws:
 * the swap proceeds. That is defensible. What was not defensible is that it
 * proceeded SILENTLY - a `logger.warn` the user never sees. Because token-api
 * sits behind the same Cloudflare gate as the aggregator, a header regression
 * meant a user swapped with ZERO honeypot protection and was never told.
 *
 * The CONFIRMED-honeypot hard block is untouched: that path still aborts before
 * anything is signed. This module only makes the UNAVAILABLE case visible, in
 * the tool result and in the persisted activity row.
 */

import { summarizeProtocolError } from "../../../runtime/errors.js";
import type { SafetyCheckFailureReason } from "./quote-safety.js";
import { classifySafetyCheckFailure } from "./quote-safety.js";

export interface SafetyCheckUnavailable {
  readonly tokenAddress: string;
  readonly tokenSymbol: string;
  /** The bounded class the quote path already uses - stable enough to key on. */
  readonly reason: SafetyCheckFailureReason;
  /**
   * The provider's REAL words, sanitized (owner decree 2026-08-02). The bounded
   * `reason` alone cannot distinguish "our client is blocked at the edge" from
   * "the venue is down", and only the first is something a user can fix.
   */
  readonly cause: string;
}

export function describeUnavailableSafetyCheck(
  token: { readonly address: string; readonly symbol: string },
  err: unknown,
): SafetyCheckUnavailable {
  return {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    reason: classifySafetyCheckFailure(err),
    cause: summarizeProtocolError(err).message,
  };
}

/** The one sentence appended to the agent-facing result when a check could not run. */
export function safetyDisclosureSentence(
  unavailable: readonly SafetyCheckUnavailable[],
): string | undefined {
  if (unavailable.length === 0) return undefined;
  const legs = unavailable
    .map((leg) => `${leg.tokenSymbol} (${leg.reason}: ${leg.cause})`)
    .join("; ");
  return `WARNING - the honeypot/fee-on-transfer check could not run for ${legs}. `
    + "This swap proceeded WITHOUT that protection; treat the token as unverified.";
}
