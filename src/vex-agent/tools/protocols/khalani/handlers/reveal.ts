/**
 * Khalani → Relay reveal surfacing (Phase-2 W3a; plan R7/R8/R9).
 *
 * Shared by the read-only quote handler (`khalani.quote.get`) and the execute
 * handler (`khalani.bridge`): on a W1-classified reveal-eligible Khalani failure
 * (a typed no-route, or an exception whose `externalName` the closed classifier
 * marks eligible), reveal the hidden Relay pair for EXACTLY this route (R8
 * route-bound) and return the agent-facing suffix. Fail-closed: a missing
 * session, or a route the Relay resolver cannot map, never reveals — the caller
 * still gets the base failure message.
 *
 * The reveal key is `resolveRelayRevealRoute(params)` (W5) — the SAME strict
 * parse the dispatch gate checks — so the unlocked route always matches the gate.
 */

import { classifyKhalaniFailure, type KhalaniFailureSignal } from "../failure-mapping.js";
import { revealRelayRoute, resolveRelayRevealRoute } from "@vex-agent/tools/registry/relay-reveal.js";

const REVEAL_SUFFIX = " A Relay fallback for this route is now available (bridge_quote_relay / bridge_execute_relay).";

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
  return REVEAL_SUFFIX;
}
