/**
 * Swap VENUE ROUTER policy — single ownership.
 *
 * Given a chain, returns the ordered list of swap venues Vex should use, primary
 * first. This is the ONE place the priority policy lives so the mutating `swap`
 * alias router, the read-only `swap_quote` router, and the agent-facing routing
 * guidance can never drift apart. Flipping priority (or adding a venue) is a
 * change HERE and nowhere else.
 *
 * Policy (Wave 2, owner decision #2):
 *   - KyberSwap-supported EVM chains → [kyberswap (primary), uniswap (fallback)].
 *   - Robinhood Chain 4663 is now KyberSwap-aggregator-supported (provisional),
 *     so it follows the same rule → [kyberswap (primary), uniswap (fallback)].
 *   - Any EVM chain Uniswap also covers gets uniswap as a fallback option.
 * Kyber stays primary wherever it is supported, so existing Kyber flows are
 * byte-identical; Uniswap is additive. Priority is driven by the Kyber chain
 * registry's `aggregator` flag — adding a chain there flips this policy for it.
 */

import { resolveChainSlug, chainSupportsFeature } from "@tools/kyberswap/chains.js";
import { resolveUniswapChainId } from "./chains.js";
import { getUniswapDeployment } from "./deployments.js";

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

// ── Runtime Kyber→Uniswap QUOTE fallback (LOCKED Wave-2 correction #3) ────────
//
// Venue SELECTION (above) is compile-time policy. The runtime fallback is the
// completion of the locked intent: when KyberSwap is the PRIMARY venue but its
// quote FAILS at runtime, the alias retries the quote on Uniswap where a verified
// deployment exists. This module owns BOTH halves of that policy so it can never
// scatter: (a) which chains have a Uniswap fallback, (b) which failures are
// fallback-eligible.

/**
 * Coarse runtime error categories (the `ErrorCategory` the protocol runtime
 * surfaces on a THROWN handler failure — see `runtime/errors.ts`) that make a
 * failed KyberSwap quote eligible for the Uniswap fallback. These are the
 * TRANSPORT / API / route-level failures: a KyberSwap API timeout, 5xx, network
 * drop, rate-limit, or "no route found" (all thrown from the aggregator client,
 * surfaced as one of these categories).
 *
 * A honeypot / token-safety verdict is NEVER in this set — and structurally can
 * never reach it: the KyberSwap quote surfaces token safety on a SUCCESSFUL quote
 * (verdict recorded, `success: true`), it does NOT throw. So the fallback can
 * only ever fire on a genuine quote FAILURE and can never launder a safety block.
 * `auth` / `unknown` are excluded (a config/opaque failure is surfaced, not
 * silently re-routed).
 */
const FALLBACK_ELIGIBLE_QUOTE_CATEGORIES: ReadonlySet<string> = new Set([
  "timeout",
  "network",
  "rate_limit",
  "provider_error",
]);

/**
 * True when a FAILED KyberSwap quote's runtime error category makes it eligible
 * for the Uniswap fallback. The alias extracts the category from the runtime's
 * failure output; this function owns the eligible SET so the policy stays in one
 * place. A returned validation failure (missing params) carries no category and
 * is therefore never eligible — only a thrown transport/route failure is.
 */
export function isFallbackEligibleQuoteCategory(category: string): boolean {
  return FALLBACK_ELIGIBLE_QUOTE_CATEGORIES.has(category);
}

/**
 * Resolve the Uniswap FALLBACK `chain` key for a chain input, or `undefined`
 * when Uniswap has no verified deployment there (then the KyberSwap error stands,
 * clean — never a guess). The key (e.g. "base", "robinhood") is what
 * `uniswap.swap.quote` takes as its `chain` param, symmetric with the primary
 * Uniswap path so the venue-bound prequote identity binds the execute to Uniswap.
 */
export function resolveUniswapFallbackChainKey(input: string): string | undefined {
  const chainId = resolveUniswapChainId(input);
  if (chainId === undefined) return undefined;
  return getUniswapDeployment(chainId)?.key ?? String(chainId);
}
