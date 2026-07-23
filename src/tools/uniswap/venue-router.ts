/**
 * Swap VENUE ROUTER policy — single ownership.
 *
 * Given a chain, returns the ordered list of swap venues Vex should use, primary
 * first. This is the ONE place the priority policy lives so the mutating
 * `swap_execute` alias router, the read-only `swap_quote` router, and the
 * agent-facing routing guidance can never drift apart. Flipping priority (or
 * adding a venue) is a change HERE and nowhere else.
 *
 * Policy (Wave 2, owner decision #2):
 *   - KyberSwap-supported EVM chains → [kyberswap (primary), uniswap (fallback
 *     OPTION — see below)].
 *   - Robinhood Chain 4663 is now KyberSwap-aggregator-supported (provisional),
 *     so it follows the same rule → [kyberswap (primary), uniswap (fallback)].
 *   - Any EVM chain Uniswap also covers gets uniswap as a fallback option.
 * Kyber stays primary wherever it is supported, so existing Kyber flows are
 * byte-identical; Uniswap is additive. Priority is driven by the Kyber chain
 * registry's `aggregator` flag — adding a chain there flips this policy for it.
 *
 * "Fallback option" is now CLASSIFICATION only (plan §11.2): `classifySwapFamily`
 * reads `resolveSwapVenues` to pick venue=kyberswap when Kyber covers the
 * chain, else venue=uniswap when ONLY Uniswap does (the "chain has no Kyber
 * support at all" reveal-eligible case). The RUNTIME retry this file used to
 * own — silently re-quoting on Uniswap after a Kyber quote FAILED — is REMOVED
 * (Agent Scan plan §4.2/§11.2): a failed Kyber quote/execute now reveals the
 * hidden Uniswap pair for the session (`tools/registry/uniswap-reveal.ts`) and
 * tells the agent to call `swap_quote_uniswap` itself, rather than silently
 * substituting a different venue's quote under the same tool call.
 */

import { resolveChainSlug, chainSupportsFeature } from "@tools/kyberswap/chains.js";
import { resolveUniswapChainId } from "./chains.js";

export type SwapVenue = "kyberswap" | "uniswap";

export interface SwapVenueOption {
  readonly venue: SwapVenue;
  /** KyberSwap chain slug (venue === "kyberswap"). */
  readonly kyberSlug?: string;
  /** Uniswap chain id (venue === "uniswap"). */
  readonly uniswapChainId?: number;
}

export interface SwapVenueResolution {
  readonly chainInput: string;
  /** venue used by the aliases (== options[0]). */
  readonly primary: SwapVenueOption;
  /** Ordered venues, primary first, fallbacks after. */
  readonly options: readonly SwapVenueOption[];
}

/** KyberSwap aggregator slug for a chain input, or undefined when not Kyber-supported. */
function kyberAggregatorSlug(input: string): string | undefined {
  try {
    const slug = resolveChainSlug(input);
    return chainSupportsFeature(slug, "aggregator") ? slug : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the ordered swap venues for a chain, or `undefined` when neither Kyber
 * nor Uniswap covers it (the caller then fails cleanly — never guesses).
 */
export function resolveSwapVenues(input: string): SwapVenueResolution | undefined {
  const options: SwapVenueOption[] = [];

  // Priority order (flip these two pushes to change primary venue policy).
  const kyberSlug = kyberAggregatorSlug(input);
  if (kyberSlug) options.push({ venue: "kyberswap", kyberSlug });

  const uniswapChainId = resolveUniswapChainId(input);
  if (uniswapChainId !== undefined) options.push({ venue: "uniswap", uniswapChainId });

  if (options.length === 0) return undefined;
  return { chainInput: input, primary: options[0]!, options };
}
