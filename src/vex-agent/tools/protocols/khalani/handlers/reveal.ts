/**
 * Khalani → Relay reveal surfacing (Phase-2 W3a; plan R7/R8/R9; REVISION 1 —
 * reveal-on-execute-revert design).
 *
 * Shared by the read-only quote handler (`khalani.quote.get`) and the execute
 * handler (`khalani.bridge`): on a W1-classified reveal-eligible Khalani
 * failure — a typed no-route, an exception whose `externalName` the closed
 * classifier marks eligible, or (REVISION 1) a `deposit_mined_revert` MINED
 * on-chain revert of the `bridge_deposit` leg — reveal the hidden Relay pair
 * for EXACTLY this route (R8 route-bound) and return the agent-facing
 * suffix. Fail-closed: a missing session, or a route the Relay resolver
 * cannot map, never reveals — the caller still gets the base failure message.
 *
 * Two suffix wordings: the QUOTE-stage suffix (no-route/exception failures,
 * all pre-broadcast) versus the EXECUTE-stage suffix (`deposit_mined_revert`
 * only, REVISION 1 R5) — distinct so the agent never blindly resubmits the
 * identical failing Khalani route on the Relay fallback; it must request a
 * FRESH `bridge_quote_relay` before considering any Relay execution. Neither
 * suffix claims Relay serviceability is proven — the reveal only unlocks a
 * read-only quote probe (REVISION 1 R2/R3).
 *
 * The reveal key is `resolveRelayRevealRoute(params)` (W5) — the SAME strict
 * parse the dispatch gate checks — so the unlocked route always matches the gate.
 */

import { classifyKhalaniFailure, type KhalaniFailureSignal } from "../failure-mapping.js";
import { revealRelayRoute, resolveRelayRevealRoute } from "@vex-agent/tools/registry/relay-reveal.js";

const QUOTE_REVEAL_SUFFIX = " A Relay fallback for this route is now available (bridge_quote_relay / bridge_execute_relay).";

const EXECUTE_REVERT_REVEAL_SUFFIX =
  " The Khalani deposit transaction reverted on-chain; no bridge was initiated. Relay quoting is now unlocked for this exact route, but Relay serviceability is not guaranteed — request bridge_quote_relay before any Relay execution.";

export function revealOnEligibleKhalaniFailure(
  signal: KhalaniFailureSignal,
  sessionId: string | undefined,
  params: Record<string, unknown>,
): string {
  if (classifyKhalaniFailure(signal).outcome !== "reveal_eligible") return "";
  if (sessionId === undefined) return "";
  const route = resolveRelayRevealRoute(params);
  if (!route) return "";
  revealRelayRoute(sessionId, route);
  return signal.kind === "deposit_mined_revert" ? EXECUTE_REVERT_REVEAL_SUFFIX : QUOTE_REVEAL_SUFFIX;
}
