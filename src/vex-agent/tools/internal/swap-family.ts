/**
 * Swap family + venue classifier — shared between the READ-ONLY `swap_quote`
 * alias and the MUTATING `swap` alias router.
 *
 * One classifier, one source of truth: both aliases route by `chain` to the same
 * family AND the same venue, so the read-only quote and the execute can never
 * disagree — if they did, the prequote gate's venue-bound match-hash would never
 * collide between the quote and the execute. The venue policy itself lives in the
 * VENUE ROUTER (`@tools/uniswap/venue-router`); this classifier just projects it
 * into the shape the aliases dispatch with.
 *
 * Pure helper: only local/no-network resolvers are consulted. No wallet, DB, or
 * privileged imports.
 */

import { isAddress } from "viem";

import { isNativeTokenInput } from "@tools/kyberswap/helpers.js";
import { resolveSwapVenues, type SwapVenue } from "@tools/uniswap/venue-router.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";

/** Chain values that route to the Solana (Jupiter) family. Checked before EVM. */
export const SOLANA_CHAIN_VALUES: ReadonlySet<string> = new Set(["solana", "sol"]);

export type SwapFamily =
  | {
      readonly kind: "evm";
      readonly venue: SwapVenue;
      /** The value to pass as the target tool's `chain` param (kyber slug or uniswap key). */
      readonly chain: string;
    }
  | { readonly kind: "solana" }
  | { readonly kind: "unknown" };

/**
 * Decide the swap family + venue from a `chain` arg. Solana is matched FIRST;
 * EVM is resolved through the VENUE ROUTER (KyberSwap primary where supported —
 * incl. Robinhood Chain — with Uniswap as the all-EVM fallback). Anything neither
 * Solana nor a routable EVM chain is `unknown` → callers fail clearly.
 */
export function classifySwapFamily(chain: string): SwapFamily {
  const normalized = chain.toLowerCase().trim();
  if (SOLANA_CHAIN_VALUES.has(normalized)) return { kind: "solana" };

  const venues = resolveSwapVenues(normalized);
  if (!venues) return { kind: "unknown" };

  const primary = venues.primary;
  if (primary.venue === "kyberswap" && primary.kyberSlug) {
    return { kind: "evm", venue: "kyberswap", chain: primary.kyberSlug };
  }
  if (primary.venue === "uniswap" && primary.uniswapChainId !== undefined) {
    const key = getUniswapDeployment(primary.uniswapChainId)?.key ?? String(primary.uniswapChainId);
    return { kind: "evm", venue: "uniswap", chain: key };
  }
  return { kind: "unknown" };
}

/**
 * True when an EVM swap token input is acceptable WITHOUT DEX symbol search: a
 * contract address (`isAddress`) OR the native token. A bare symbol is rejected
 * by callers (symbol search can match the wrong contract). Shared by the EVM
 * branches of `swap_quote` and `swap` so both reject a symbol identically.
 */
export function isEvmSwapTokenInput(input: string): boolean {
  return isNativeTokenInput(input) || isAddress(input);
}
