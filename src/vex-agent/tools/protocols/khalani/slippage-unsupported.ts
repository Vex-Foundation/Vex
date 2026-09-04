/**
 * Khalani has NO slippage surface - and says so BY NAME.
 *
 * Khalani's `/v1/quotes` field list carries no slippage tolerance: a route is
 * filled by a filler at the quoted route price, inside the route's own
 * deadline. Until the audit (SPEC §2.4 item 21) the generic bridge aliases
 * accepted `slippageBps` on the Khalani branch and silently DROPPED it - the
 * one param an agent sets specifically to bound its downside, answered with
 * silence. An agent that set it believed it had constrained its loss and had
 * not.
 *
 * The same doctrine `findCallerSuppliedForbiddenParam` applies to
 * `referrer`/`refundTo` therefore applies here: reject by name, say why, and
 * say what protection actually exists instead.
 */

import { resolveBridgeVenue } from "@tools/relay/bridge-venue.js";

/** The ONE agent-facing sentence, shared by every Khalani bridge entry point. */
export const KHALANI_SLIPPAGE_UNSUPPORTED_REASON =
  "slippageBps is not an accepted parameter on a Khalani bridge - a Khalani route is filled by a "
  + "filler at the quoted route price, so Khalani exposes no slippage tolerance and the value would "
  + "have had no effect. NO slippage protection applies on Khalani routes: your protection is the "
  + "quoted route itself and its deadline, so compare the quoted amountOut and re-quote if the "
  + "deadline has passed. Remove slippageBps and retry.";

/**
 * The by-name refusal for a caller-supplied `slippageBps` on a bridge call that
 * the venue router sends to KHALANI, or `null` when there is nothing to refuse.
 *
 * Reads the RAW alias args, before schema parsing, for two reasons: the Relay
 * branch types the param as a number, so a Khalani-routed `slippageBps:"100"`
 * would otherwise be answered with a type complaint instead of the real reason;
 * and the refusal must never depend on the value being well-formed.
 *
 * `subject` is the agent-facing entry point being called (e.g. `BridgeQuote`),
 * so the message names the call the agent actually made.
 */
export async function khalaniSlippageRejection(
  subject: string,
  params: Record<string, unknown>,
): Promise<string | null> {
  const value = params.slippageBps;
  if (value === undefined || value === null || value === "") return null;
  const fromChain = typeof params.fromChain === "string" ? params.fromChain : "";
  const toChain = typeof params.toChain === "string" ? params.toChain : "";
  // A decision that names no venue is NOT answered here: the router owns that
  // refusal and states the real cause. Claiming "Khalani rejects slippageBps"
  // when we do not know the route even goes to Khalani would be a false reason.
  const decision = await resolveBridgeVenue(fromChain, toChain);
  if (decision.venue !== "khalani") return null;
  return `${subject}: ${KHALANI_SLIPPAGE_UNSUPPORTED_REASON}`;
}
