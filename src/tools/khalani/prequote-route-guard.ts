/**
 * Pre-quote bridge route guard (Phase 2 W1, binding R9).
 *
 * BEFORE quoting Khalani, decide the venue for a from→to route against the LIVE
 * Khalani registry and the local EVM-chain registry. The live registry is
 * already family-filtered to eip155 + solana by `validateChainsResponse` (it
 * skips bitcoin/tron), so membership in the fetched list IS the post-family
 * filter — a `tron` alias that resolves via `CHAIN_ALIASES` is absent from the
 * fetched registry and therefore correctly treated as not-Khalani.
 *
 * Outcomes (R9, superseding the earlier "skip Khalani → static Relay" prose):
 *   - both endpoints present in the live Khalani registry  → `khalani`
 *   - a LOCAL chain (Robinhood 4663) on EITHER side         → `static_relay`
 *     Khalani does not cover local chains, so Relay is the direct route with no
 *     prior Khalani failure needed; W5's dispatch carve-out always allows it.
 *   - a NONLOCAL endpoint absent from the live registry     → `no_route`
 *     A typed no-route that feeds the ROUTE-BOUND Relay reveal — NEVER a silent
 *     direct Relay call.
 *
 * The `no_route` outcome is FAILURE-shaped: it can never be mistaken for a
 * Khalani-serviceable route, so it cannot seed a successful prequote.
 *
 * `classifyKhalaniPrequoteRoute` is pure (takes the already-family-filtered
 * chains list); `resolveKhalaniPrequoteRoute` is the async convenience that
 * fetches the live registry. A registry-fetch failure PROPAGATES (fail closed —
 * we never guess the venue), it is not swallowed into a false result.
 */

import { resolveLocalChainId } from "../evm-chains/registry.js";
import { getCachedKhalaniChains, resolveChainId } from "./chains.js";
import type { KhalaniChain } from "./types.js";

export type KhalaniPrequoteRouteSide = "from" | "to";

export type KhalaniPrequoteRoute =
  | { readonly outcome: "khalani"; readonly fromChainId: number; readonly toChainId: number }
  | {
      readonly outcome: "static_relay";
      readonly localChainId: number;
      readonly localSide: KhalaniPrequoteRouteSide;
    }
  | { readonly outcome: "no_route"; readonly missing: readonly KhalaniPrequoteRouteSide[] };

type SideClassification =
  | { readonly kind: "khalani"; readonly chainId: number }
  | { readonly kind: "local"; readonly chainId: number }
  | { readonly kind: "absent" };

/**
 * Resolve an input to a chain id that is GENUINELY in the (family-filtered)
 * Khalani registry, or `undefined`. `resolveChainId` does a numeric passthrough
 * for any positive integer and honours `CHAIN_ALIASES`, so — like the inclusive
 * resolver — we verify the resolved id is actually present before trusting it.
 */
function resolveKhalaniRegistryId(input: string, chains: KhalaniChain[]): number | undefined {
  try {
    const id = resolveChainId(input, chains);
    return chains.some((chain) => chain.id === id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function classifySide(input: string, chains: KhalaniChain[]): SideClassification {
  const khalaniId = resolveKhalaniRegistryId(input, chains);
  if (khalaniId !== undefined) {
    return { kind: "khalani", chainId: khalaniId };
  }
  const localId = resolveLocalChainId(input);
  if (localId !== undefined) {
    return { kind: "local", chainId: localId };
  }
  return { kind: "absent" };
}

/**
 * Pure classifier over the already family-filtered live Khalani registry.
 * Local-chain precedence matches the venue router: a local chain on either side
 * routes to static Relay regardless of the other side.
 */
export function classifyKhalaniPrequoteRoute(
  fromChain: string,
  toChain: string,
  chains: KhalaniChain[],
): KhalaniPrequoteRoute {
  const from = classifySide(fromChain, chains);
  const to = classifySide(toChain, chains);

  // Local chain on either side → static Relay (Khalani never covers local chains).
  if (from.kind === "local") {
    return { outcome: "static_relay", localChainId: from.chainId, localSide: "from" };
  }
  if (to.kind === "local") {
    return { outcome: "static_relay", localChainId: to.chainId, localSide: "to" };
  }

  // Both endpoints genuinely in the live Khalani registry → Khalani.
  if (from.kind === "khalani" && to.kind === "khalani") {
    return { outcome: "khalani", fromChainId: from.chainId, toChainId: to.chainId };
  }

  // A nonlocal endpoint absent from the live registry → typed no-route (reveal).
  const missing: KhalaniPrequoteRouteSide[] = [];
  if (from.kind === "absent") {
    missing.push("from");
  }
  if (to.kind === "absent") {
    missing.push("to");
  }
  return { outcome: "no_route", missing };
}

/**
 * Async convenience: fetch the live (family-filtered) Khalani registry and
 * classify. A fetch failure propagates — the caller treats it as a transport
 * failure and does NOT guess a venue.
 */
export async function resolveKhalaniPrequoteRoute(
  fromChain: string,
  toChain: string,
): Promise<KhalaniPrequoteRoute> {
  const chains = await getCachedKhalaniChains();
  return classifyKhalaniPrequoteRoute(fromChain, toChain, chains);
}
