/**
 * Bridge VENUE ROUTER policy - Khalani vs Relay.
 *
 * Single-ownership policy for which bridge provider a route uses, mirroring the
 * swap venue router. Flip priority (or extend) HERE and nowhere else.
 *
 * CHAIN-AWARE since the owner decision of 2026-08-17: Relay is the DEFAULT
 * fallback bridge next to Khalani, not a Robinhood-only special case. The rule
 * that replaced the hardcoded 4663 test is the honest one: consult the LIVE
 * Khalani chain registry (`tools/khalani/chains.ts`, cached 24h) and route to
 * Relay whenever a side of the route is absent from it. Robinhood Chain still
 * goes to Relay - now because Khalani's own registry says it does not serve it,
 * rather than because a constant said so. Chains such as HyperEVM (999) and
 * Sonic (146) were being sent to Khalani by the old rule and refused at its
 * edge, costing the agent a turn to learn what the registry already knew.
 *
 * The registry read is NOT optional and its failure is NOT resolved silently.
 * An unreadable Khalani registry leaves the venue genuinely UNKNOWN: routing to
 * Khalani would repeat the old refusal, and routing to Relay would send a route
 * Khalani serves to the venue with the worse price. Both are guesses on a money
 * path, so the decision carries a refusal instead and the caller says so.
 */

import { resolveLocalChainId } from "@tools/evm-chains/registry.js";
import { getCachedKhalaniChains, CHAIN_ALIASES } from "@tools/khalani/chains.js";
import { resolveChainSlug, slugToChainId, isNumericChainIdInput } from "@tools/kyberswap/chains.js";

export type BridgeVenue = "khalani" | "relay";

/**
 * The venue a route resolves to, or a refusal when no venue can be named
 * honestly. `venue: null` is never a silent default - it always carries the
 * agent-facing sentence explaining what is unknown and what to do.
 */
export type BridgeVenueDecision =
  | { readonly venue: BridgeVenue; readonly refusal?: undefined }
  | { readonly venue: null; readonly refusal: string };

/**
 * Resolve one chain input to a chain id WITHOUT deciding anything about venue
 * coverage. Every registry in the tree that maps a name to an id is consulted
 * (local chains, the Khalani alias table plus the bare numeric form, and the
 * KyberSwap slug table) because the caller may spell a chain any of those ways.
 * `undefined` means no registry in Vex knows the name at all.
 */
function resolveChainIdForRouting(input: string): number | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) return undefined;

  const local = resolveLocalChainId(normalized);
  if (local !== undefined) return local;

  if (isNumericChainIdInput(normalized)) {
    const numeric = Number(normalized);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
  }

  const aliased = CHAIN_ALIASES[normalized];
  if (aliased !== undefined) return aliased;

  try {
    return slugToChainId(resolveChainSlug(normalized));
  } catch {
    return undefined;
  }
}

function unresolvableChainRefusal(input: string): string {
  return `"${input}" is not a chain Vex can resolve, so neither Khalani nor Relay can be asked to `
    + "bridge it. Name the chain by the slug or numeric chain id `token_find` returns.";
}

const KHALANI_REGISTRY_UNREADABLE_REFUSAL =
  "The bridge venue for this route cannot be determined right now: Khalani's chain registry could "
  + "not be read, and which venue serves this route depends on it. Vex will not guess between the "
  + "two bridges on a transfer of funds. Retry the call; if it keeps failing, bridge from a "
  + "different chain or wait for Khalani to come back.";

/**
 * A route that reaches Relay is not thereby proven serviceable: Relay's OWN
 * `/chains` registry and its route-health gate (`./health.ts`) refuse
 * fail-closed for a chain Relay does not serve. That refusal is the second half
 * of "neither bridge serves this side" and stays where the live Relay registry
 * is - this module never enumerates Relay's catalog.
 */

/**
 * The default bridge venue for a route, or a refusal.
 *
 * Awaits the 24h-cached Khalani chain list, so the FIRST call in a process
 * fetches it and every later call in the day is local. The quote alias and the
 * execute alias both go through here, so they always agree on the venue - which
 * is what the venue-bound bridge prequote gate depends on.
 */
export async function resolveBridgeVenue(
  fromChain: string,
  toChain: string,
): Promise<BridgeVenueDecision> {
  const fromId = resolveChainIdForRouting(fromChain);
  if (fromId === undefined) return { venue: null, refusal: unresolvableChainRefusal(fromChain) };
  const toId = resolveChainIdForRouting(toChain);
  if (toId === undefined) return { venue: null, refusal: unresolvableChainRefusal(toChain) };

  let khalaniChainIds: ReadonlySet<number>;
  try {
    const chains = await getCachedKhalaniChains();
    // An EMPTY registry is read as unreadable, not as "Khalani serves nothing".
    // Khalani always lists chains, so an empty list is a provider hiccup, and
    // treating it as coverage would silently divert every route to Relay.
    if (chains.length === 0) return { venue: null, refusal: KHALANI_REGISTRY_UNREADABLE_REFUSAL };
    khalaniChainIds = new Set(chains.map((chain) => chain.id));
  } catch {
    return { venue: null, refusal: KHALANI_REGISTRY_UNREADABLE_REFUSAL };
  }

  const khalaniServesBothSides = khalaniChainIds.has(fromId) && khalaniChainIds.has(toId);
  return { venue: khalaniServesBothSides ? "khalani" : "relay" };
}
