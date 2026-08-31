/**
 * Quote-tiered USD pricing over DexScreener pair rows - ONE owner for the
 * rule, one injected policy per chain.
 *
 * ## Why "deepest liquidity wins" alone is WRONG (measured 2026-08-26)
 *
 * The rule this module used to implement was "a wanted token is priced from
 * either pair side, and across every pair fed in the deepest `liquidity.usd`
 * wins, regardless of which side matched". That rule priced JUP
 * (`JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN`) at **$1136.11** while SOL was
 * $96.76, and the owner's Solana portfolio USD is a money display.
 *
 * Archived under `scratchpad/solana-probes/`:
 *
 *  - `/tokens/v1/solana/JUP...` answered ONE representative pool, JUP/MET on
 *    meteora, `liquidity.usd` 176,433,673, `priceUsd` "1136.11".
 *  - `/token-pairs/v1/solana/JUP...` answered 30 pools: six JUP/MET pools all
 *    between $1130 and $1153, one JUP/SOL meteora pool at `priceNative`
 *    "0.002239" (x 96.76 = $0.2166), and a JUP/USDC pool at `priceUsd`
 *    "0.2170".
 *
 * MET is mispriced on the provider's side, so BOTH the USD price and the USD
 * liquidity of every JUP/MET pool are fiction - and because that fiction
 * inflates `liquidity.usd` by ~5000x, "deepest wins" selects it every time.
 * Depth denominated in an asset we cannot value is not evidence.
 *
 * ## The rule (owner decision 2026-08-26, refined the same day)
 *
 * Classify each pair by its QUOTE asset into a TRUSTED set and everything else:
 *
 *  - **Tier 0**, quote is a USD stablecoin on this chain. TRUSTED.
 *  - **Tier 1**, quote is the chain's wrapped native. TRUSTED.
 *  - **Tier 2**, any other quote asset. NEVER a price source, at any depth. A
 *    token whose only pools are tier 2 stays UNPRICED, which is honest; the
 *    caller may then spend one extra read on the full pool list (see
 *    `unpriced-pool-fallback.ts`) before giving up.
 *
 * Among ALL trusted pools of a token the DEEPEST `liquidity.usd` wins,
 * whichever class it belongs to. The tier is NOT a precedence: it selects the
 * ARITHMETIC, not the winner. The owner's reason, and it is the right one: a
 * memecoin with a $2k USDC pool and a $1M SOL pool has its true price in the
 * SOL pool, and preferring the stable one on principle would report the
 * thinner market. Depth is only misleading when it is denominated in something
 * we cannot value, which is exactly what tier 2 excludes.
 *
 * The winning pool's class then decides the conversion:
 *
 *  - tier 0: the provider's `priceUsd` verbatim (base side), or
 *    `priceUsd / priceNative` when the wanted token IS the stablecoin (quote
 *    side);
 *  - tier 1: `priceNative * nativeUsd`, using OUR native price, never the
 *    provider's implied one.
 *
 * ## The liquidity floor
 *
 * A pool below {@link PRICE_SOURCE_MIN_LIQUIDITY_USD} is not a price source at
 * all, trusted quote or not. MEASURED: jlUSDC priced at $1.058 out of a $43
 * pool - a number with no market behind it. A token whose only trusted pools
 * are sub-floor is UNPRICED and reports `below_liquidity_floor`, so the gap is
 * visible rather than filled with noise.
 *
 * `nativeUsd` is derived from the same folded batches, in this order:
 *
 *  1. the deepest tier-0 pool whose BASE is the wrapped native (wSOL/USDC,
 *     WETH/USDG) - our own anchored price;
 *  2. otherwise the provider's implied native price `priceUsd / priceNative`
 *     from the deepest tier-1 pool. This leg is not theoretical: on the live
 *     robinhood index WETH has appeared ONLY as a quote token, which is why
 *     base-only matching once left native ETH permanently unpriced.
 *
 * With no `nativeUsd` at all, every tier-1 candidate resolves to UNPRICED
 * rather than to a number derived from an unknown native price.
 *
 * ## Address identity is INJECTED, never assumed
 *
 * EVM addresses are case-insensitive, so the EVM caller normalizes to
 * lowercase and reads the map back by lowercase key. Solana mints are base58,
 * where case IS identity (`Es9v...` and `es9v...` are different strings, and
 * the `proj_balances` predicate compares `token_address` with no `LOWER()`),
 * so the Solana caller injects the identity function and DexScreener's echoed
 * `baseToken.address` is used verbatim. A single hardcoded `toLowerCase()`
 * here would silently corrupt every Solana mint key. The SAME function is
 * applied to the policy's own addresses, so a policy table may be written in
 * whatever case its registry already uses.
 *
 * ## One accumulator is ONE chain, and that is ENFORCED
 *
 * A quote policy is a per-chain table and an address is only an identity within
 * one chain: the same 20 bytes are a stablecoin on one EVM chain and an
 * anonymous contract on the next. A pass therefore declares the DexScreener
 * chain identifier it is valuing ({@link
 * BestLiquidityPriceAccumulatorOptions.expectedChainId}, the same slug the
 * caller puts in the request URL) and every row whose `chainId` is not that
 * chain is REFUSED, not merely unused. The refusals are counted and reachable
 * through {@link BestLiquidityPriceAccumulator.foreignChainPairsRefused} so a
 * caller can log that the provider answered off-chain rows rather than silently
 * discarding them. The comparison is case-insensitive: the provider's slug
 * vocabulary is ASCII lowercase and the caller passes the slug it requested.
 *
 * ## Numbers off the wire are parsed, never trusted
 *
 * `liquidity.usd` is the ONLY tie-break between trusted pools, so it goes
 * through the same finite-and-non-negative parse as every price field: an
 * `Infinity`, a string or a negative depth would otherwise decide which pool
 * prices a wallet. Both `priceUsd / priceNative` inversions are guarded the same
 * way at the point they are produced, so a denormal `priceNative` cannot emit a
 * non-finite USD price. An unusable candidate is never offered, so it can never
 * suppress a shallower valid one.
 */

import type { DexPair } from "./types.js";

/**
 * Per-chain quote-asset policy. Addresses are in the caller's own address form
 * and are put through `normalizeAddress` before any comparison.
 */
export interface QuoteAssetPolicy {
  /** USD stablecoins on this chain. May be empty: a chain can have none. */
  readonly stables: ReadonlySet<string>;
  /** The chain's wrapped native token (wSOL, WETH). */
  readonly wrappedNative: string;
}

/**
 * Minimum `liquidity.usd` for a pool to be a price source at all.
 *
 * MEASURED 2026-08-26: a $43 pool reported jlUSDC at $1.058. Below this floor a
 * quoted price is an artifact of an empty book, not a market, and a portfolio
 * that multiplies a balance by it displays a number nobody could realise. The
 * floor applies to EVERY pool, including the ones that anchor `nativeUsd`.
 */
export const PRICE_SOURCE_MIN_LIQUIDITY_USD = 1_000;

/**
 * Which TRUSTED quote class a winning pool belongs to. It selects the
 * arithmetic used to reach USD; it is NOT a precedence between pools.
 * 0 = quoted in a USD stable, 1 = quoted in the wrapped native.
 */
export type PricedQuoteTier = 0 | 1;

/** Why a wanted address ended up with no price. */
export type UnpricedReason =
  /** No pool at all, or only pools quoted in an asset we cannot value (tier 2). */
  | "no_trusted_pool"
  /** Trusted pools existed, but every one of them was below the floor. */
  | "below_liquidity_floor"
  /** A tier-1 pool won, but no pool anywhere supplied a native USD price. */
  | "no_native_price";

/** How one USD number was produced, so a log can say WHY this price won. */
export type PriceBasis =
  /** Tier 0, wanted token is the base: the provider's `priceUsd` verbatim. */
  | "stable-quote-price-usd"
  /** Tier 0, wanted token IS the stablecoin: `priceUsd / priceNative`. */
  | "stable-quote-inverted"
  /** Tier 1: `priceNative * nativeUsd`. */
  | "native-quote-multiple"
  /** The wrapped native itself, taken from the resolved `nativeUsd`. */
  | "native-anchor";

/** Why one wanted address ended up with the price it has. */
export interface PriceDecision {
  readonly tier: PricedQuoteTier;
  readonly basis: PriceBasis;
  readonly pairAddress: string;
  readonly liquidityUsd: number;
  readonly quoteSymbol: string | null;
}

/** Tier census over one valuation pass, for the sync completion log. */
export interface PriceTierCounts {
  readonly tier0: number;
  readonly tier1: number;
  readonly unpriced: number;
}

export interface BestLiquidityPriceAccumulatorOptions {
  /** Token addresses to price, in the caller's own address form. */
  readonly wanted: Iterable<string>;
  /**
   * The caller's address-identity policy, applied to BOTH the wanted set and
   * every provider-echoed address before comparison. Lowercase for EVM,
   * identity for Solana base58.
   */
  readonly normalizeAddress: (address: string) => string;
  /** Which quote assets may price a token on this chain. */
  readonly quotePolicy: QuoteAssetPolicy;
  /**
   * The DexScreener chain identifier this pass values - the same slug the
   * caller puts in the request URL ("solana", "base", "robinhood"). Rows
   * carrying any other `chainId` are refused: an address is an identity only
   * within one chain, and this policy is one chain's table.
   */
  readonly expectedChainId: string;
}

export interface BestLiquidityPriceAccumulator {
  /** Fold one batch of provider pair rows into the running best-price state. */
  addPairs(pairs: readonly DexPair[]): void;
  /** Normalized address -> USD price. A fresh map per call. */
  toPriceMap(): Map<string, number>;
  /** Normalized address -> why that price won. Same key set as `toPriceMap`. */
  toDecisionMap(): Map<string, PriceDecision>;
  /** The resolved native USD price, or null when no tier-0/1 pool supplied one. */
  nativeUsd(): number | null;
  /** Tier census across the whole wanted set, unpriced addresses included. */
  countTiers(): PriceTierCounts;
  /** Wanted addresses with no usable candidate yet. */
  unpricedAddresses(): string[];
  /** Why each unpriced address is unpriced. Same key set as `unpricedAddresses`. */
  unpricedReasons(): Map<string, UnpricedReason>;
  /**
   * Rows refused so far because their `chainId` was not `expectedChainId`.
   * Non-zero means the provider answered another chain's pools for this
   * request; nothing was priced from them.
   */
  foreignChainPairsRefused(): number;
}

/**
 * Count each unpriced reason, for a log line that says WHY a token has no
 * price rather than only that it has none. Prices are public market data, so
 * nothing here is a secret.
 */
export function summarizeUnpricedReasons(
  accumulator: Pick<BestLiquidityPriceAccumulator, "unpricedReasons">,
): Record<UnpricedReason, number> {
  const counts: Record<UnpricedReason, number> = {
    no_trusted_pool: 0,
    below_liquidity_floor: 0,
    no_native_price: 0,
  };
  for (const reason of accumulator.unpricedReasons().values()) counts[reason] += 1;
  return counts;
}

/** A parsed, non-negative finite number, or undefined when the field is unusable. */
function finiteNonNegative(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Strictly positive: a divisor or a native multiplier of 0 carries no price. */
function finitePositive(raw: unknown): number | undefined {
  const value = finiteNonNegative(raw);
  return value !== undefined && value > 0 ? value : undefined;
}

/**
 * `priceUsd / priceNative` in dollars, or undefined when the quotient is not a
 * usable price. The divisor is already strictly positive, but a DENORMAL one
 * (`5e-324`) still overflows the quotient to Infinity, and a "usd" candidate is
 * returned VERBATIM at resolve time - only the "native" branch multiplies and
 * re-checks. Guarding here is what keeps a non-finite dollar value out of a
 * money display, and an unusable quotient is simply not offered, so it can
 * never outrank a shallower valid candidate.
 */
function invertedUsdPrice(priceUsd: number, priceNative: number): number | undefined {
  return finiteNonNegative(priceUsd / priceNative);
}

/** One competing price for one wanted address, resolved at `toPriceMap` time. */
interface Candidate {
  readonly tier: PricedQuoteTier;
  readonly basis: PriceBasis;
  readonly liquidityUsd: number;
  /** "usd" is already dollars; "native" must still be multiplied by nativeUsd. */
  readonly kind: "usd" | "native";
  readonly value: number;
  readonly pairAddress: string;
  readonly quoteSymbol: string | null;
}

/**
 * The DEEPEST trusted pool wins, whichever class it is. Both candidates have
 * already cleared {@link PRICE_SOURCE_MIN_LIQUIDITY_USD} and both are trusted,
 * so depth is the only remaining question.
 */
function beats(next: Candidate, current: Candidate | undefined): boolean {
  if (current === undefined) return true;
  return next.liquidityUsd > current.liquidityUsd;
}

/**
 * Create an accumulator for one valuation pass. Stateful by design: a caller
 * that batches its addresses (DexScreener's `tokens/v1` caps at 30) must let
 * pairs from a later batch - or from a follow-up pool-list read - compete with
 * an earlier batch's candidates.
 */
export function createBestLiquidityPriceAccumulator(
  options: BestLiquidityPriceAccumulatorOptions,
): BestLiquidityPriceAccumulator {
  const { normalizeAddress } = options;
  const wanted = new Set<string>();
  for (const address of options.wanted) wanted.add(normalizeAddress(address));

  const stables = new Set<string>();
  for (const address of options.quotePolicy.stables) stables.add(normalizeAddress(address));
  const wrappedNative = normalizeAddress(options.quotePolicy.wrappedNative);

  const expectedChainId = options.expectedChainId.toLowerCase();
  let foreignChainPairs = 0;

  const candidates = new Map<string, Candidate>();
  /** Wanted addresses that HAD a trusted pool, but only below the floor. */
  const sawSubFloorTrustedPool = new Set<string>();
  /** Deepest tier-0 pool with the wrapped native as base. */
  let nativeAnchor: Candidate | undefined;
  /** Deepest tier-1 pool, carrying the provider's implied native price. */
  let nativeImplied: Candidate | undefined;

  const offer = (key: string, candidate: Candidate): void => {
    if (beats(candidate, candidates.get(key))) candidates.set(key, candidate);
  };

  /** 0 stable-quoted, 1 native-quoted, 2 anything else (unknown quote included). */
  const tierOf = (quote: string | undefined): 0 | 1 | 2 => {
    if (quote === undefined) return 2;
    if (stables.has(quote)) return 0;
    if (quote === wrappedNative) return 1;
    return 2;
  };

  const resolveNativeUsd = (): number | null => nativeAnchor?.value ?? nativeImplied?.value ?? null;

  const resolve = (candidate: Candidate, nativeUsd: number | null): number | undefined => {
    if (candidate.kind === "usd") return candidate.value;
    if (nativeUsd === null) return undefined;
    const price = candidate.value * nativeUsd;
    return Number.isFinite(price) && price >= 0 ? price : undefined;
  };

  /** The wrapped native's own row, taken from whichever source set nativeUsd. */
  const nativeDecision = (): { price: number; decision: PriceDecision } | undefined => {
    const source = nativeAnchor ?? nativeImplied;
    if (source === undefined) return undefined;
    return {
      price: source.value,
      decision: {
        tier: source.tier,
        basis: "native-anchor",
        pairAddress: source.pairAddress,
        liquidityUsd: source.liquidityUsd,
        quoteSymbol: source.quoteSymbol,
      },
    };
  };

  const buildPrices = (): Map<string, { price: number; decision: PriceDecision }> => {
    const nativeUsd = resolveNativeUsd();
    const resolved = new Map<string, { price: number; decision: PriceDecision }>();
    for (const [key, candidate] of candidates) {
      const price = resolve(candidate, nativeUsd);
      if (price === undefined) continue;
      resolved.set(key, {
        price,
        decision: {
          tier: candidate.tier,
          basis: candidate.basis,
          pairAddress: candidate.pairAddress,
          liquidityUsd: candidate.liquidityUsd,
          quoteSymbol: candidate.quoteSymbol,
        },
      });
    }
    // The wrapped native is priced by the SAME number every tier-1 token is
    // multiplied by, so the portfolio cannot disagree with itself about it.
    if (wanted.has(wrappedNative)) {
      const native = nativeDecision();
      if (native !== undefined) resolved.set(wrappedNative, native);
    }
    return resolved;
  };

  return {
    addPairs(pairs: readonly DexPair[]): void {
      for (const pair of pairs) {
        // One accumulator values ONE chain. A row from another chain carries
        // addresses this policy cannot interpret, so it prices nothing and is
        // counted rather than quietly ignored.
        if (pair.chainId?.toLowerCase() !== expectedChainId) {
          foreignChainPairs += 1;
          continue;
        }

        // The ONLY tie-break between trusted pools, so it is parsed like a
        // price: Infinity, a string or a negative depth scores 0 (sub-floor),
        // never "deepest".
        const liquidityUsd = finiteNonNegative(pair.liquidity?.usd) ?? 0;
        const meetsFloor = liquidityUsd >= PRICE_SOURCE_MIN_LIQUIDITY_USD;
        const pairAddress = pair.pairAddress;
        const rawQuote = pair.quoteToken?.address;
        const quote = rawQuote == null ? undefined : normalizeAddress(rawQuote);
        const quoteSymbol = pair.quoteToken?.symbol ?? null;
        const tier = tierOf(quote);

        const priceUsd = finiteNonNegative(pair.priceUsd);
        const priceNative = finitePositive(pair.priceNative);

        const rawBase = pair.baseToken?.address;
        const base = rawBase == null ? undefined : normalizeAddress(rawBase);

        // A sub-floor pool prices nothing, but it is REMEMBERED so an unpriced
        // token can say "the pools existed and were too thin" rather than
        // "there were no pools".
        if (!meetsFloor) {
          if (tier !== 2) {
            if (base !== undefined && wanted.has(base)) sawSubFloorTrustedPool.add(base);
            if (quote !== undefined && wanted.has(quote)) sawSubFloorTrustedPool.add(quote);
          }
          continue;
        }

        // ── nativeUsd sources, independent of the wanted set ──
        if (tier === 0 && base === wrappedNative && priceUsd !== undefined) {
          const anchor: Candidate = {
            tier: 0,
            basis: "stable-quote-price-usd",
            liquidityUsd,
            kind: "usd",
            value: priceUsd,
            pairAddress,
            quoteSymbol,
          };
          if (beats(anchor, nativeAnchor)) nativeAnchor = anchor;
        } else if (tier === 1 && priceUsd !== undefined && priceNative !== undefined) {
          const impliedNativeUsd = invertedUsdPrice(priceUsd, priceNative);
          if (impliedNativeUsd !== undefined) {
            const implied: Candidate = {
              tier: 1,
              basis: "stable-quote-inverted",
              liquidityUsd,
              kind: "usd",
              value: impliedNativeUsd,
              pairAddress,
              quoteSymbol,
            };
            if (beats(implied, nativeImplied)) nativeImplied = implied;
          }
        }

        // ── base side: the wanted token is what the pair prices ──
        if (base !== undefined && wanted.has(base)) {
          if (tier === 0 && priceUsd !== undefined) {
            offer(base, {
              tier: 0,
              basis: "stable-quote-price-usd",
              liquidityUsd,
              kind: "usd",
              value: priceUsd,
              pairAddress,
              quoteSymbol,
            });
          } else if (tier === 1 && priceNative !== undefined) {
            offer(base, {
              tier: 1,
              basis: "native-quote-multiple",
              liquidityUsd,
              kind: "native",
              value: priceNative,
              pairAddress,
              quoteSymbol,
            });
          }
        }

        // ── quote side: the wanted token IS the quote asset ──
        //
        // Only meaningful at tier 0, where the wanted token is the stablecoin
        // itself. A wanted token that is the wrapped native is priced by the
        // nativeUsd anchor above, and tier 2 never prices anything.
        if (
          quote !== undefined &&
          tier === 0 &&
          wanted.has(quote) &&
          priceUsd !== undefined &&
          priceNative !== undefined
        ) {
          const invertedUsd = invertedUsdPrice(priceUsd, priceNative);
          if (invertedUsd !== undefined) {
            offer(quote, {
              tier: 0,
              basis: "stable-quote-inverted",
              liquidityUsd,
              kind: "usd",
              value: invertedUsd,
              pairAddress,
              quoteSymbol,
            });
          }
        }
      }
    },
    toPriceMap(): Map<string, number> {
      const prices = new Map<string, number>();
      for (const [key, resolved] of buildPrices()) prices.set(key, resolved.price);
      return prices;
    },
    toDecisionMap(): Map<string, PriceDecision> {
      const decisions = new Map<string, PriceDecision>();
      for (const [key, resolved] of buildPrices()) decisions.set(key, resolved.decision);
      return decisions;
    },
    nativeUsd(): number | null {
      return resolveNativeUsd();
    },
    countTiers(): PriceTierCounts {
      const resolved = buildPrices();
      let tier0 = 0;
      let tier1 = 0;
      for (const address of wanted) {
        const decision = resolved.get(address)?.decision;
        if (decision === undefined) continue;
        if (decision.tier === 0) tier0 += 1;
        else tier1 += 1;
      }
      return { tier0, tier1, unpriced: wanted.size - tier0 - tier1 };
    },
    unpricedAddresses(): string[] {
      const resolved = buildPrices();
      return [...wanted].filter((address) => !resolved.has(address));
    },
    unpricedReasons(): Map<string, UnpricedReason> {
      const resolved = buildPrices();
      const nativeUsd = resolveNativeUsd();
      const reasons = new Map<string, UnpricedReason>();
      for (const address of wanted) {
        if (resolved.has(address)) continue;
        // A candidate that survived selection but produced no number can only
        // have been a tier-1 one with nothing to multiply by.
        if (candidates.has(address) && nativeUsd === null) {
          reasons.set(address, "no_native_price");
        } else if (sawSubFloorTrustedPool.has(address)) {
          reasons.set(address, "below_liquidity_floor");
        } else {
          reasons.set(address, "no_trusted_pool");
        }
      }
      return reasons;
    },
    foreignChainPairsRefused(): number {
      return foreignChainPairs;
    },
  };
}
