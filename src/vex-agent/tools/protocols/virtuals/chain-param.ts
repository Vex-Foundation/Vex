/**
 * The `chain` param of `virtuals.list` / `virtuals.graduations` — the canonical
 * slug set the manifest advertises, and the translation into the UPPERCASE
 * spelling the Virtuals API demands.
 *
 * WHY THE TRANSLATION LIVES HERE. SPEC §1.1: "per-provider translation stays in
 * the adapter, never in the manifest". Virtuals is the one namespace whose chain
 * values were UPPERCASE in the model-facing schema — an agent that had just read
 * `chain: "base"` off a KyberSwap tool had to know, from nothing, that this one
 * provider spells it `BASE`. The manifest now advertises `base | solana |
 * robinhood | ethereum` with a declared `enum`, and the four-value uppercase
 * vocabulary stops at this seam.
 *
 * The set is CLOSED and provider-imposed: `VIRTUALS_CHAINS` in
 * `@tools/virtuals/types.ts` is the client's own union, so this table is derived
 * from it (one entry per member) rather than hand-listed twice.
 *
 * Numeric chain ids are accepted because CANONICAL_CHAIN_SENTENCE promises them
 * on every chain-valued param and `TokenFind` hands the agent numbers. Solana
 * has no EVM chain id, so it is reachable by slug only — which is true of every
 * Solana lane in the tree.
 */

import { VIRTUALS_CHAINS, type VirtualsChain } from "@tools/virtuals/types.js";

interface VirtualsChainEntry {
  /** The canonical lowercase slug the manifest advertises. */
  readonly slug: string;
  /** The decimal chain id, or null where the chain has none (Solana). */
  readonly chainId: string | null;
}

/**
 * One entry per {@link VIRTUALS_CHAINS} member. Typed as a total record so
 * adding a chain to the client union fails to compile until it is described
 * here, rather than silently becoming unreachable by slug.
 */
const CHAIN_BY_PROVIDER_VALUE: Record<VirtualsChain, VirtualsChainEntry> = {
  BASE: { slug: "base", chainId: "8453" },
  SOLANA: { slug: "solana", chainId: null },
  ROBINHOOD: { slug: "robinhood", chainId: "4663" },
  ETH: { slug: "ethereum", chainId: "1" },
};

/** The declared `enum` of the manifest's `chain` param, in provider order. */
export const VIRTUALS_CHAIN_SLUGS: readonly string[] = VIRTUALS_CHAINS.map(
  (chain) => CHAIN_BY_PROVIDER_VALUE[chain].slug,
);

/**
 * The canonical slug for a resolved provider value — what a handler echoes, so
 * the reply spells the chain the way the agent must spell it on the next call.
 */
export function virtualsChainSlug(chain: VirtualsChain): string {
  return CHAIN_BY_PROVIDER_VALUE[chain].slug;
}

/**
 * Resolve any accepted spelling to the provider's value.
 *
 * Accepted: the canonical slug, the decimal chain id, and — case-insensitively —
 * the provider's own UPPERCASE value, which was the documented spelling before
 * this rename and is still what the API echoes back in its rows.
 *
 * @returns `null` when the value names no Virtuals chain; the caller refuses by
 * name with the legal set, never by silently defaulting.
 */
export function resolveVirtualsChain(raw: string): VirtualsChain | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  for (const chain of VIRTUALS_CHAINS) {
    const entry = CHAIN_BY_PROVIDER_VALUE[chain];
    if (value === entry.slug || value === chain.toLowerCase() || value === entry.chainId) {
      return chain;
    }
  }
  return null;
}
