/**
 * Khalani -> Relay venue-fallback messaging.
 *
 * Shared by the read-only quote handler (`khalani.quote.get`) and the execute
 * handler (`khalani.bridge`): on a Khalani failure that a SECOND VENUE can
 * actually remedy - a typed no-route, an exception the closed classifier marks
 * eligible, or a `deposit_mined_revert` MINED on-chain revert of the
 * `bridge_deposit` leg - return the agent-facing suffix naming Relay.
 *
 * NO LONGER A REVEAL (owner decision D4). `BridgeQuoteRelay` /
 * `BridgeExecuteRelay` are always callable; nothing here unlocks them, and
 * there is no route-bound session state left to write. What survives is the
 * DISCRIMINATION: this note is appended only to failures Relay could serve, so
 * a failure Relay cannot help with is never answered with "try Relay".
 *
 * Two suffix wordings: the QUOTE-stage suffix (no-route/exception failures, all
 * pre-broadcast) versus the EXECUTE-stage suffix (`deposit_mined_revert` only) -
 * distinct so the agent never blindly resubmits the identical failing Khalani
 * route on Relay; it must request a FRESH `BridgeQuoteRelay` before any Relay
 * execution. Neither suffix claims Relay serviceability is proven.
 */

import { classifyKhalaniFailure, type KhalaniFailureSignal } from "../failure-mapping.js";

const QUOTE_FALLBACK_SUFFIX =
  " Relay is an alternative venue for this route: preview it with BridgeQuoteRelay, then execute with BridgeExecuteRelay.";

const EXECUTE_REVERT_FALLBACK_SUFFIX =
  " The Khalani deposit transaction reverted on-chain; no bridge was initiated. Relay is an alternative venue for this route, but Relay serviceability is not guaranteed - request a fresh BridgeQuoteRelay before any Relay execution.";

/**
 * `sessionId` and `params` are retained in the signature and deliberately
 * unused: they were the fail-closed inputs to the retired route-bound reveal
 * (the route had to be resolvable for the reveal key to exist). Keeping them
 * keeps five call sites unchanged, and the note itself is route-independent
 * now, because the venue is always callable.
 */
export function venueFallbackNoteOnKhalaniFailure(
  signal: KhalaniFailureSignal,
  _sessionId: string | undefined,
  _params: Record<string, unknown>,
): string {
  if (classifyKhalaniFailure(signal).outcome !== "fallback_eligible") return "";
  return signal.kind === "deposit_mined_revert" ? EXECUTE_REVERT_FALLBACK_SUFFIX : QUOTE_FALLBACK_SUFFIX;
}
