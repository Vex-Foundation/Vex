/**
 * DexScreener price enrichment for Khalani balance rows that arrive WITHOUT a
 * price - the ONE implementation shared by the background sync
 * (`vex-agent/sync/balance-sync.ts`) and the agent-facing `WalletBalances` tool
 * (`vex-agent/tools/internal/wallet/read.ts`), so a live read and a projection
 * can never disagree about what a holding is worth.
 *
 * ## Why this exists (measured, not anticipated)
 *
 * 2026-08-26 11:25Z: Khalani's balance scan stopped populating
 * `extensions.price.usd`. Base and Arbitrum rows for ETH and USDC came back
 * with a null price, and the owner's portfolio dropped $23.71 for that reason
 * alone - the balances were right, only the prices were gone.
 *
 * It lived in `vex-agent/sync/khalani-price-fallback.ts` until 2026-08-31,
 * coupled to the persisted `BalanceRow`, which is why only the SYNC path ever
 * ran it: the live wallet read returned the provider's nulls untouched and
 * reported a smaller portfolio than the sidebar for the same wallet at the same
 * moment. The shape here follows the precedent set by
 * `tools/evm-chains/balances.ts` and
 * `tools/solana-ecosystem/balances/read-wallet-balances.ts`: one pricing owner
 * in `tools/`, over the PROVIDER's own row type, with no database in it.
 *
 * ## Ownership, and what this must never do
 *
 * Khalani is the BALANCE source and remains the PREFERRED price source: a row
 * that already carries a readable Khalani price is returned untouched, byte for
 * byte, and only a row whose null this fills is cloned. It never reads a
 * balance, never adds, drops or reorders a row, and never changes a chain id,
 * an address or a raw amount.
 *
 * The price itself comes from the same quote-tiered rule every other Vex
 * pricing path uses (`tools/dexscreener/best-liquidity-price.ts`): only a pool
 * quoted in a stablecoin we recognise or in the chain's wrapped native, above
 * the shared liquidity floor, may price a token, and the deepest such pool
 * wins. A chain absent from `evm-chain-quote-policy.ts` gets NO enrichment and
 * its rows stay unpriced, because guessing a slug would price a token off
 * another chain's identically-addressed contract.
 *
 * Native rows (`0xEeee...`, `0x0`, `native` - the closed alias set owned by
 * `./native-token-identity.ts`) have no pair of their own, so they are looked
 * up under the chain's WRAPPED native and take that chain's `nativeUsd`.
 *
 * ## Provenance is INTERNAL
 *
 * Each returned row carries `priceSource` for logging and tests. It is
 * deliberately NOT written into the token and NOT visible to the model: the
 * frozen balance-row contract (C1) has no such field, and adding one would be a
 * contract amendment nobody approved.
 *
 * ## Bounds and cancellation
 *
 * One batched `tokens/v1` read per chain per pass, 30 addresses per request
 * (the provider's cap), issued sequentially, and the chain's wrapped native is
 * ALWAYS one of those addresses - it anchors every tier-1 price and is the only
 * source of a native row's own value. Chains are processed SEQUENTIALLY: one
 * wallet's valuation is not worth fanning out on a shared provider budget.
 *
 * Fail-soft per chain for a PROVIDER failure: the chain's rows stay exactly as
 * Khalani sent them. The one thing that is never fail-soft is the caller's own
 * cancellation, which PROPAGATES as the signal's reason. A Stop converted into
 * "these rows are unpriced" would be a wrong number reported as a measurement,
 * and would keep issuing the remaining chains' requests after the operator
 * stopped.
 *
 * A token the representative pool list leaves unpriced then gets the SAME
 * bounded `token-pairs/v1` second pass the per-chain wallet readers run
 * (`dexscreener/unpriced-pool-fallback.ts`: at most
 * `UNPRICED_POOL_FALLBACK_MAX_ADDRESSES` sequential reads per chain, fail-soft
 * per address, addresses beyond the cap reported as skipped). One token must
 * not carry two different prices depending on which lane read it.
 */

import {
  createBestLiquidityPriceAccumulator,
  summarizeUnpricedReasons,
  type PriceDecision,
} from "../dexscreener/best-liquidity-price.js";
import { getEvmChainQuotePolicy } from "../dexscreener/evm-chain-quote-policy.js";
import { readTokensPairs } from "../dexscreener/price-read.js";
import { addPoolListsForUnpricedAddresses } from "../dexscreener/unpriced-pool-fallback.js";
import { isKhalaniNativeAlias } from "./native-token-identity.js";
import type { KhalaniToken } from "./types.js";
import logger from "../../utils/logger.js";

/** The provider's own cap for `tokens/v1`. */
const DEXSCREENER_TOKENS_BATCH = 30;

/**
 * Where a row's final price came from. INTERNAL: logging and tests only, never
 * a field on the token and never model-visible (C1 carries no such field).
 */
export type KhalaniPriceSource = "khalani" | "dexscreener" | null;

/** One row of the pass, in the caller's original order. */
export interface EnrichedKhalaniToken {
  /** The original token, or a clone whose null price this pass filled. */
  readonly token: KhalaniToken;
  readonly priceSource: KhalaniPriceSource;
}

/** Per-chain census, logged so a portfolio number can be traced to its source. */
export interface KhalaniPriceEnrichmentCounts {
  readonly chainId: number;
  /** Rows Khalani itself priced. Never touched here. */
  readonly khalaniPriced: number;
  /** Rows this pass priced from DexScreener. */
  readonly dexscreenerPriced: number;
  /** Rows still without a price after both. */
  readonly unpriced: number;
}

export interface KhalaniPriceEnrichmentResult {
  /** Same length and same order as the input. */
  readonly rows: readonly EnrichedKhalaniToken[];
  /** One entry per chain present in the input, in first-appearance order. */
  readonly counts: readonly KhalaniPriceEnrichmentCounts[];
}

export interface KhalaniPriceEnrichmentOptions {
  /**
   * The CALLER's cancellation. This pass issues sequential provider reads per
   * chain, so without it an operator Stop waits for every remaining chain. It
   * reaches each request and is re-checked between them, and it PROPAGATES: a
   * cancelled pass throws the signal's reason rather than reporting rows as
   * unpriced.
   */
  readonly signal?: AbortSignal;
}

/**
 * The price a Khalani token already carries, or null when it has none we can
 * read.
 *
 * Deliberately the SAME predicate as the projection boundary
 * (`vex-agent/tools/protocols/amount-display.ts`, `readPriceUsd`) and the
 * completeness axis (`hasUsdPrice`): finite and non-negative, blank and
 * unparseable treated as absent. Those live above this layer and cannot be
 * imported here, so the rule is restated rather than shared - and it must stay
 * in step with them, because a row this pass calls "already priced" while the
 * projection calls it unpriced is a holding that can never be valued.
 */
function readKhalaniPriceUsd(token: KhalaniToken): number | null {
  const raw = token.extensions?.price?.usd;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * A clone of `token` carrying `priceUsd`, with every other field, including the
 * rest of the open `extensions` bag, preserved.
 *
 * The price is written in the provider's own form (a decimal STRING under
 * `extensions.price.usd`) so downstream readers cannot tell a filled row from a
 * Khalani-priced one by its shape - the provenance is carried beside the row,
 * not inside it.
 */
function withPriceUsd(token: KhalaniToken, priceUsd: number): KhalaniToken {
  return {
    ...token,
    extensions: {
      ...token.extensions,
      price: { ...token.extensions?.price, usd: String(priceUsd) },
    },
  };
}

/** One chain's slice of the input, keeping each token's index in the original array. */
interface ChainSlice {
  readonly chainId: number;
  readonly entries: Array<{ readonly index: number; readonly token: KhalaniToken }>;
}

/**
 * Fill null prices in one chain's Khalani rows from DexScreener.
 *
 * Writes each entry's outcome into `out` at the entry's ORIGINAL index, so the
 * caller never has to re-order anything. Never throws for a provider failure;
 * a cancellation propagates.
 */
async function enrichChain(
  slice: ChainSlice,
  out: EnrichedKhalaniToken[],
  signal: AbortSignal | undefined,
): Promise<KhalaniPriceEnrichmentCounts> {
  const { chainId, entries } = slice;
  const priced = entries.filter((entry) => readKhalaniPriceUsd(entry.token) !== null);
  for (const entry of priced) out[entry.index] = { token: entry.token, priceSource: "khalani" };

  const needPricing = entries.filter((entry) => readKhalaniPriceUsd(entry.token) === null);
  const chain = getEvmChainQuotePolicy(chainId);

  if (chain === undefined || needPricing.length === 0) {
    for (const entry of needPricing) out[entry.index] = { token: entry.token, priceSource: null };
    return {
      chainId,
      khalaniPriced: priced.length,
      dexscreenerPriced: 0,
      unpriced: needPricing.length,
    };
  }

  // A native row has no pair of its own; it is priced as the wrapped native.
  const lookupFor = (token: KhalaniToken): string =>
    isKhalaniNativeAlias(token.address)
      ? chain.policy.wrappedNative
      : token.address.toLowerCase();

  // COVERAGE set: exactly the addresses the rows need. The tier census and the
  // unpriced census are computed over this set, so the seed below stays out.
  const wanted = [...new Set(needPricing.map((entry) => lookupFor(entry.token)))];
  const accumulator = createBestLiquidityPriceAccumulator({
    wanted,
    normalizeAddress: (address) => address.toLowerCase(),
    quotePolicy: chain.policy,
    expectedChainId: chain.slug,
  });

  // REQUEST set: the wanted addresses PLUS the chain's wrapped native, always.
  // The wrapped native is the anchor every tier-1 price is multiplied by, and
  // seeding it only when a native ROW happens to need pricing left the anchor
  // unreachable while a giant WETH/USDC pool sat one address away in the same
  // request. It rides in a batch that is issued anyway, is not counted in the
  // census, and does not consume a pool-list rescue slot.
  const wrappedNative = chain.policy.wrappedNative.toLowerCase();
  const pricingAddresses = wanted.includes(wrappedNative) ? wanted : [...wanted, wrappedNative];

  for (let i = 0; i < pricingAddresses.length; i += DEXSCREENER_TOKENS_BATCH) {
    // Between batches: a Stop that arrived while the previous read was settling
    // ends the pass here rather than starting the next request.
    signal?.throwIfAborted();
    const batch = pricingAddresses.slice(i, i + DEXSCREENER_TOKENS_BATCH);
    try {
      // The options bag is passed ONLY when there is a signal, so a caller that
      // asks for no cancellation makes the exact two-argument call this lane
      // always made, which is what its suite characterizes.
      const pairs = signal === undefined
        ? await readTokensPairs(chain.slug, batch.join(","))
        : await readTokensPairs(chain.slug, batch.join(","), { signal });
      accumulator.addPairs(pairs);
    } catch (err) {
      // A cancellation is the CALLER's outcome, never a provider failure to be
      // logged and stepped over. Asked first, so a stopped read cannot be
      // recorded as "this chain could not be priced".
      if (signal?.aborted === true) throw signal.reason;
      logger.debug("khalani.balance_price_enrichment.batch_failed", {
        chainId,
        slug: chain.slug,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  // Second, bounded pass, IDENTICAL to the one both wallet readers run: the
  // provider's representative pool for a token can be the very tier-2 pool the
  // rule refuses, while its full pool list carries a tier-0 one. Two lanes
  // pricing one token differently is a portfolio that disagrees with itself, so
  // this lane spends the same bounded budget
  // (`UNPRICED_POOL_FALLBACK_MAX_ADDRESSES` sequential reads, fail-soft per
  // address) on the ROW addresses only - the wrapped-native seed is not one of
  // them.
  const rescue = await addPoolListsForUnpricedAddresses(
    { accumulator, chainSlug: chain.slug, addresses: wanted, ...(signal ? { signal } : {}) },
    (address) => address.toLowerCase(),
    (address, err) => {
      logger.debug("khalani.balance_price_enrichment.pool_list_failed", {
        chainId,
        slug: chain.slug,
        token: address,
        error: err instanceof Error ? err.name : "unknown",
      });
    },
  );
  if (rescue.attempted > 0 || rescue.skipped > 0) {
    logger.debug("khalani.balance_price_enrichment.pool_list", {
      chainId,
      slug: chain.slug,
      ...rescue,
    });
  }

  const foreignChainPairs = accumulator.foreignChainPairsRefused();
  if (foreignChainPairs > 0) {
    logger.warn("khalani.balance_price_enrichment.foreign_chain_pairs", {
      chainId,
      slug: chain.slug,
      pairs: foreignChainPairs,
    });
  }

  const prices = accumulator.toPriceMap();
  const decisions = accumulator.toDecisionMap();
  let dexscreenerPriced = 0;
  let unpriced = 0;

  for (const entry of needPricing) {
    const lookup = lookupFor(entry.token);
    const priceUsd = prices.get(lookup);
    if (priceUsd === undefined) {
      unpriced += 1;
      out[entry.index] = { token: entry.token, priceSource: null };
      continue;
    }
    dexscreenerPriced += 1;
    logFilledRow(chainId, entry.token, priceUsd, decisions.get(lookup));
    out[entry.index] = { token: withPriceUsd(entry.token, priceUsd), priceSource: "dexscreener" };
  }

  if (unpriced > 0) {
    logger.debug("khalani.balance_price_enrichment.unpriced_reasons", {
      chainId,
      slug: chain.slug,
      ...summarizeUnpricedReasons(accumulator),
    });
  }

  return { chainId, khalaniPriced: priced.length, dexscreenerPriced, unpriced };
}

/** One line per filled row saying WHICH pool and WHICH tier produced the price. */
function logFilledRow(
  chainId: number,
  token: KhalaniToken,
  priceUsd: number,
  decision: PriceDecision | undefined,
): void {
  logger.debug("khalani.balance_price_enrichment.row", {
    chainId,
    token: token.symbol,
    tokenAddress: token.address,
    priceUsd,
    tier: decision?.tier ?? null,
    basis: decision?.basis ?? null,
    pairAddress: decision?.pairAddress ?? null,
    quoteSymbol: decision?.quoteSymbol ?? null,
    liquidityUsd: decision?.liquidityUsd ?? null,
  });
}

/**
 * Fill the null prices of one Khalani balance scan, chain by chain.
 *
 * Returns one row per input token, in the SAME order, each carrying the token
 * (the original object unless this pass filled its price) and the internal
 * provenance of the price it ended up with.
 *
 * Never throws for a provider failure; a chain that cannot be priced keeps
 * exactly the rows Khalani produced. The caller's cancellation propagates.
 */
export async function enrichKhalaniBalancePrices(
  tokens: readonly KhalaniToken[],
  options: KhalaniPriceEnrichmentOptions = {},
): Promise<KhalaniPriceEnrichmentResult> {
  const out = new Array<EnrichedKhalaniToken>(tokens.length);
  const slices = new Map<number, ChainSlice>();
  tokens.forEach((token, index) => {
    const slice = slices.get(token.chainId) ?? { chainId: token.chainId, entries: [] };
    slice.entries.push({ index, token });
    slices.set(token.chainId, slice);
  });

  const counts: KhalaniPriceEnrichmentCounts[] = [];
  for (const slice of slices.values()) {
    options.signal?.throwIfAborted();
    const chainCounts = await enrichChain(slice, out, options.signal);
    counts.push(chainCounts);
    if (chainCounts.dexscreenerPriced > 0 || chainCounts.unpriced > 0) {
      logger.info("khalani.balance_price_enrichment", chainCounts);
    }
  }

  return { rows: out, counts };
}
