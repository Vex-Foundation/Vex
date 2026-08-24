/**
 * Venue-fallback messaging — the ONE place this venue decides whether a
 * KyberSwap failure is one a SECOND VENUE can actually remedy, and what the
 * agent is told about it.
 *
 * NO LONGER A REVEAL (owner decision D4). `SwapQuoteUniswap` /
 * `SwapExecuteUniswap` are always callable; nothing here unlocks them. What
 * survives, and is the whole reason this module still exists, is the
 * DISCRIMINATION: a route-not-found, an unsafe or pre-sign-refused build, a
 * mined revert, or an unreachable KyberSwap edge are conditions another venue
 * can serve, while slippage, allowance/balance, a stale deadline, and a price
 * floor are conditions a fresh quote or a corrected amount clears and a second
 * venue does NOT. Naming Uniswap on the latter would be false advice, so these
 * functions stay closed over the classifier
 * (`registry/venue-fallback-eligibility.ts`) rather than appending the note to
 * every failure.
 *
 * Each entry point pairs ONE failure shape with ONE agent-facing suffix. The
 * availability class is the only one that picks between two: "the venue is
 * throttling us" and "the venue's edge refuses this client" call for opposite
 * first moves.
 */

import type { AgentActivityEventRole } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import { isVenueFallbackWorthwhile } from "../../../../registry/venue-fallback-eligibility.js";
import type { KyberVenueUnavailableReason } from "../../../../registry/venue-fallback-eligibility.js";
import type { EvmRouterRevertFailureCode } from "@tools/evm-chains/router-revert-reason.js";
import {
  deriveKyberFallbackSignal,
  deriveKyberMinedRevertFallbackSignal,
  deriveKyberPreSignRevertFallbackSignal,
} from "../../failure-mapping.js";

/** The ONE sentence naming the alternative venue — shared so a second copy cannot drift from the tool names it must name exactly. */
const FALLBACK_VENUE_AVAILABLE_SUFFIX =
  " Uniswap is an alternative venue for this trade: quote it with SwapQuoteUniswap, then execute with SwapExecuteUniswap.";

/**
 * Appended whenever the availability class points at Uniswap. A KyberSwap edge
 * that refuses us on one chain refuses us on all of them, but Uniswap's
 * coverage is chain-specific, so the sentence says so rather than letting the
 * agent discover it as a second failure.
 */
const UNISWAP_COVERAGE_CAVEAT =
  " Uniswap covers only the EVM chains with a verified Vex deployment, so quote there first and act on what that quote says.";

/** Availability class, terminal: repeating the same KyberSwap request cannot clear it. */
const VENUE_UNAVAILABLE_TERMINAL_LEAD =
  " That is a venue-availability failure, not a refusal of this trade: KyberSwap did not price the route at all, and repeating the same request there will be answered the same way.";

/** Availability class, possibly transient: one backed-off retry on KyberSwap is the cheaper first move. */
const VENUE_UNAVAILABLE_RETRY_FIRST_LEAD =
  " That is a venue-availability failure, not a refusal of this trade, and it may be temporary: retry the same KyberSwap request once after a short backoff before switching venue.";

/**
 * Which availability reasons are worth one retry on KyberSwap FIRST. Messaging
 * policy, so it lives with the wording; eligibility policy stays in the
 * classifier. An edge refusal and a missing endpoint are terminal for this
 * client, so telling the agent to retry them would be false advice.
 */
const RETRY_KYBER_FIRST_REASONS: ReadonlySet<KyberVenueUnavailableReason> = new Set([
  "rate_limited", "server_error", "timeout", "unreachable",
]);

/**
 * On a KyberSwap failure a second venue can remedy, return the suffix naming
 * Uniswap. Returns "" for every other failure — the caller still gets the base
 * message, unpolluted by advice that would not help.
 *
 * `sessionId` is retained in the signature and deliberately unused: it was the
 * fail-closed input to the retired reveal. Keeping the parameter keeps five
 * call sites unchanged; the note itself is session-independent, because the
 * venue is always callable.
 */
export function venueFallbackNoteOnFailure(
  err: unknown,
  _sessionId: string | undefined,
  tokenInputsValidated: boolean,
): string {
  const signal = deriveKyberFallbackSignal(err, tokenInputsValidated);
  if (!signal || !isVenueFallbackWorthwhile(signal)) return "";
  if (signal.kind === "venue_unavailable") {
    logger.info("kyberswap.fallback.venue_unavailable", { reason: signal.reason });
    const lead = RETRY_KYBER_FIRST_REASONS.has(signal.reason)
      ? VENUE_UNAVAILABLE_RETRY_FIRST_LEAD
      : VENUE_UNAVAILABLE_TERMINAL_LEAD;
    return `${lead}${FALLBACK_VENUE_AVAILABLE_SUFFIX}${UNISWAP_COVERAGE_CAVEAT}`;
  }
  return FALLBACK_VENUE_AVAILABLE_SUFFIX;
}

/**
 * On a PRE-SIGN gas-estimate revert of the `swap` leg with nothing broadcast,
 * return the suffix APPENDED to the refusal (never replacing it — the chain's
 * reason and the remedy stay the primary content).
 *
 * It reuses the quote-stage sentence rather than the execute-stage one on
 * purpose: the execute-stage wording exists to stop an agent resubmitting a
 * route whose gas was already burned, and here nothing was signed, spent, or
 * broadcast — there is no such warning to give.
 *
 * Both gates (`swap` role, nothing broadcast) live in
 * `deriveKyberPreSignRevertFallbackSignal`; the admitted failure codes live in
 * the eligibility classifier.
 */
export function venueFallbackNoteOnPreSignRevert(input: {
  readonly eventRole: AgentActivityEventRole;
  readonly legBroadcastAttempted: boolean;
  readonly failureCode: EvmRouterRevertFailureCode;
  readonly sessionId: string;
}): string {
  const signal = deriveKyberPreSignRevertFallbackSignal(input);
  if (!signal || !isVenueFallbackWorthwhile(signal)) return "";
  return FALLBACK_VENUE_AVAILABLE_SUFFIX;
}

/**
 * On a `swap`-role MINED on-chain revert (`outcome.kind === "reverted"` in the
 * staged broadcast loop), return the EXECUTE-stage suffix — distinct wording
 * from `venueFallbackNoteOnFailure`'s quote-stage suffix so the agent does not
 * blindly resubmit the identical failing Kyber route on the other venue.
 * `eventRole` gates construction of the signal at
 * `deriveKyberMinedRevertFallbackSignal`: an allowance/allowance_reset leg
 * reverting is an ERC-20 condition, never venue evidence.
 *
 * `sessionId` is retained and unused for the same reason as above.
 */
export function venueFallbackNoteOnMinedRevert(eventRole: AgentActivityEventRole, _sessionId: string): string {
  const signal = deriveKyberMinedRevertFallbackSignal(eventRole);
  if (!signal || !isVenueFallbackWorthwhile(signal)) return "";
  return " The gas for this attempt was spent and nothing was swapped. A mined revert on a swap is most often the price guard: the pool moved past the minimum output written into the calldata after the pre-sign estimate passed. FIRST re-quote the SAME Kyber route with a higher slippageBps (Vex caps it at 1000) — switching venue does not fix a price-guard revert, another venue at the same tolerance reverts the same way. If a fresh Kyber quote is then refused for a ROUTING reason rather than price, Uniswap is the alternative venue: SwapQuoteUniswap.";
}
