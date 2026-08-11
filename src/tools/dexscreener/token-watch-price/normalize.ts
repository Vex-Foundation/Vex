/**
 * Normalize one DexScreener pool to the price of the token we are WATCHING.
 *
 * DexScreener prices the pool's BASE token: `priceUsd` is the base token in USD
 * and `priceNative` is the base token denominated in the quote token. A pool
 * where the watched token sits on the QUOTE side therefore reports someone
 * else's price, and reading it raw would arm a threshold against the wrong
 * asset. The quote-side value is `priceUsd / priceNative`, the same rule
 * `evm-chains/balances.ts` already applies to wallet valuation - restated here
 * as an exact-decimal derivation rather than a float, because this number is
 * compared against a threshold rather than displayed.
 */

import type { DexPair } from "../types.js";
import {
  divideBoundedDecimals,
  isPositiveDecimal,
  parseBoundedDecimal,
  type BoundedDecimal,
} from "./decimal.js";

export type TokenWatchPoolSide = "base" | "quote";

export interface TokenWatchPriceCandidate {
  readonly pairAddress: string;
  readonly dexId: string;
  readonly side: TokenWatchPoolSide;
  /** USD price OF THE WATCHED TOKEN, exact. */
  readonly priceUsd: BoundedDecimal;
  /** Pool depth in USD, `0` when the provider omitted it. Selection tiebreak. */
  readonly liquidityUsd: number;
}

/**
 * Which side of this pool the watched token sits on, or `null` if neither.
 *
 * `matches` is supplied by the caller because address IDENTITY is chain-family
 * specific: an EVM address is case-insensitive (its mixed case is a checksum),
 * while a base58 mint is case-SENSITIVE and two spellings are two mints.
 */
function poolSide(
  pair: DexPair,
  matches: (candidate: string | null | undefined) => boolean,
): TokenWatchPoolSide | null {
  if (matches(pair.baseToken?.address)) return "base";
  if (matches(pair.quoteToken?.address)) return "quote";
  return null;
}

function liquidityUsd(pair: DexPair): number {
  const value = pair.liquidity?.usd;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * `null` when this pool cannot state the watched token's price: it does not
 * hold the token, it carries no usable `priceUsd`, or (quote side) its
 * `priceNative` is missing or zero and the derivation is undefined.
 */
export function normalizePoolToWatchedToken(
  pair: DexPair,
  matches: (candidate: string | null | undefined) => boolean,
): TokenWatchPriceCandidate | null {
  const side = poolSide(pair, matches);
  if (side === null) return null;

  const priceUsd = parseBoundedDecimal(pair.priceUsd);
  if (priceUsd === null || !isPositiveDecimal(priceUsd)) return null;

  let normalized = priceUsd;
  if (side === "quote") {
    const priceNative = parseBoundedDecimal(pair.priceNative);
    if (priceNative === null || !isPositiveDecimal(priceNative)) return null;
    const derived = divideBoundedDecimals(priceUsd, priceNative);
    if (derived === null || !isPositiveDecimal(derived)) return null;
    normalized = derived;
  }

  return {
    pairAddress: typeof pair.pairAddress === "string" ? pair.pairAddress : "",
    dexId: typeof pair.dexId === "string" ? pair.dexId : "",
    side,
    priceUsd: normalized,
    liquidityUsd: liquidityUsd(pair),
  };
}
