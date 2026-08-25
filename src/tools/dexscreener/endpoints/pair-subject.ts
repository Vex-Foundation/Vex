/**
 * The SUBJECT of a deep-dive call: which pool, on which AMM, quoted in which
 * token, in which orientation.
 *
 * WHY THIS IS ITS OWN OWNER. Candles, trades and top traders are three
 * different channels with three different codecs, and all three are keyed by
 * facts the caller does not have and must not be asked for:
 *
 *  - `ammId` is `typeAMM.a` on the pair row, never `dexId`. A WRONG ammId
 *    answers HTTP 200 with ZERO ROWS (measured), which reads to an agent as
 *    "nothing traded here" rather than "you asked the wrong question".
 *  - the QUOTE TOKEN decides orientation. A wrong `q` on the bars endpoint
 *    returns a silently INVERTED series that is byte-identical in shape to a
 *    correct one (measured). There is no way to detect it downstream, so the
 *    quote is resolved FROM THE PAIR and a caller-supplied quote is not part
 *    of any deep-dive tool's parameter surface.
 *
 * Both facts live on one provider row, so resolving them once and handing the
 * three channels a validated subject is the only arrangement in which none of
 * them can be pointed at the wrong series. That is a single-responsibility
 * seam protecting a money-path invariant, which is exactly the case rule 01
 * says justifies an abstraction even before the second consumer.
 *
 * It also owns the token-to-pool resolution the resolve family already needed,
 * so "deepest pool of the provider's bounded window" has ONE implementation
 * and one honesty clause rather than one per family.
 */

import { projectPairRow } from "../screen-core/project.js";
import { DexScreenerSiteErrorCodes, siteError } from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";
import { fetchPairSnapshot } from "./pair-live.js";
import { searchPairs, SEARCH_PROVIDER_WINDOW } from "./search.js";

/** How the pool address in a subject was arrived at. */
export type SubjectResolutionBasis =
  | "explicit_pair_address"
  | "deepest_of_search_window";

/** A token address resolved to a pool. */
export interface ResolvedPair {
  readonly pairAddress: string;
  /** How many rows the provider's bounded window actually returned. */
  readonly windowSize: number;
  /**
   * How many of those rows were pools of the requested token, which is the
   * candidate set the depth comparison actually ran over. Always at most
   * `windowSize`, and usually smaller: the window ranks by relevance, so other
   * tokens ride along.
   */
  readonly matchedInWindow: number;
}

/**
 * Everything the three pair-keyed deep-dive channels need, resolved once.
 *
 * `quoteTokenAddress` is the provider's own spelling and is case-sensitive on
 * the Solana routes, so it is carried verbatim and never re-cased.
 */
export interface PairSubject {
  readonly chainId: string;
  /** The provider's spelling of the pool address. */
  readonly pairAddress: string;
  /** `typeAMM.a`. The routing key for bars, trades and top traders. */
  readonly ammId: string;
  readonly baseTokenAddress: string;
  readonly baseTokenSymbol: string | null;
  /**
   * The pair's own quote token, VERBATIM as the provider spelled it.
   *
   * THIS FIELD IS AN ORIENTATION KEY AND IT IS CASE-SENSITIVE. Three endpoints
   * take it (`q` on the chart and top-traders routes, `quoteTokenAddress` on the
   * Connect trades read, `quoteTokenId` on the feed socket) and ALL THREE answer
   * HTTP 200 with the pair SILENTLY INVERTED when it is wrong, absent, naming
   * the base token, or merely the CORRECT ADDRESS LOWER-CASED. There is no
   * error, no warning, and no way to tell from the rows.
   *
   * Measured 2026-08-25 on ethereum PEPE/WETH:
   *  - top traders, `q=0xC02aaA39...` against `q=0xc02aaa39...`: the same top
   *    maker comes back as `buys 956, volumeUsdBuy 5,219,201.99, amountBuy
   *    "1468926772500.29"` (PEPE) or as `buys 864, volumeUsdBuy 4,315,234.24,
   *    amountBuy "1913.84"` (WETH). Buy and sell are transposed, the amounts are
   *    in the other token, and `netCashFlowUsd` FLIPS SIGN.
   *  - bars: native `0.000000001683` against `593955106.9585`, seventeen orders
   *    of magnitude, on both transports.
   *
   * So this value is NEVER caller-supplied, NEVER re-cased, and NEVER
   * hand-built. It is read from the provider's own pair snapshot and forwarded
   * byte for byte. `pairAddress` carries the same rule on EVM: the checksum
   * spelling returns rows and the lowercased one returns 200 with zero.
   *
   * A future normalization anywhere on this path inverts three tools at once,
   * silently. The guard against it is the describe block "no provider identity
   * is normalized on any deep-dive request" in
   * `src/__tests__/dexscreener-site/deep-dive-endpoints.test.ts`.
   */
  readonly quoteTokenAddress: string;
  readonly quoteTokenSymbol: string | null;
  readonly dexId: string | null;
  readonly labels: readonly string[];
  readonly priceUsd: string | null;
  readonly liquidityUsd: number | null;
  readonly pairCreatedAtMs: number | null;
  readonly resolutionBasis: SubjectResolutionBasis;
  /** The token address the caller passed, when the pool came from one. */
  readonly resolvedFromToken: string | null;
  /** Rows the bounded search window returned, when one was used. */
  readonly searchWindowSize: number | null;
  readonly fetchedAtMs: number;
}

export interface ResolveSubjectOptions {
  readonly transport: DexScreenerTransport;
  readonly chainId: string;
  /** An explicit pool address. Wins over `tokenAddress` when both are given. */
  readonly pairAddress?: string;
  readonly tokenAddress?: string;
  /** Deadline for ONE provider exchange, in milliseconds. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Resolve a caller's identity into a validated deep-dive subject.
 *
 * Fails CLOSED on both keys. A pair whose row carries no `typeAMM.a` and a
 * pair whose row carries no quote token address are REFUSALS, not subjects
 * with a hole in them, because either one produces a plausible-looking empty
 * or inverted answer downstream.
 */
export async function resolvePairSubject(
  options: ResolveSubjectOptions
): Promise<PairSubject> {
  const explicit = options.pairAddress ?? "";
  const token = options.tokenAddress ?? "";
  if (explicit === "" && token === "") {
    throw siteError(
      DexScreenerSiteErrorCodes.PAIR_IDENTITY_MISSING,
      "Neither pairAddress nor tokenAddress was given, so there is no pool to read",
      "Pass pairAddress for a known pool, or tokenAddress to resolve the deepest pool of the provider's bounded search window."
    );
  }

  let pairAddress = explicit;
  let resolutionBasis: SubjectResolutionBasis = "explicit_pair_address";
  let resolvedFromToken: string | null = null;
  let searchWindowSize: number | null = null;
  if (explicit === "") {
    const resolved = await resolveDeepestPair({
      transport: options.transport,
      chainId: options.chainId,
      tokenAddress: token,
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    pairAddress = resolved.pairAddress;
    resolutionBasis = "deepest_of_search_window";
    resolvedFromToken = token;
    searchWindowSize = resolved.windowSize;
  }

  const snapshot = await fetchPairSnapshot({
    chainId: options.chainId,
    pairAddress,
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const row = projectPairRow(snapshot.row, {
    window: "h24",
    nowMs: snapshot.fetchedAtMs,
  });

  if (row.ammId === null || row.ammId === "") {
    throw siteError(
      DexScreenerSiteErrorCodes.AMM_ID_UNRESOLVED,
      `The DexScreener row for ${options.chainId}:${pairAddress} carries no AMM id (typeAMM.a), which every candle, trade and top-trader route is keyed by`,
      "Without it the provider answers HTTP 200 with zero rows, which would read as \"nothing traded on this pool\". Check the pool address, or read the pool with dexscreener__pair_get first."
    );
  }
  const quote = row.quoteToken.address;
  if (quote === "") {
    throw siteError(
      DexScreenerSiteErrorCodes.BARS_QUOTE_UNRESOLVED,
      `The DexScreener row for ${options.chainId}:${pairAddress} carries no quote token address, so the series orientation cannot be established`,
      "A wrong quote returns a silently INVERTED price series that looks identical to a correct one, so this is refused rather than answered. Read the pool with dexscreener__pair_get to see what the provider knows about it."
    );
  }

  return {
    chainId: options.chainId,
    pairAddress: row.pairAddress,
    ammId: row.ammId,
    baseTokenAddress: row.baseToken.address,
    baseTokenSymbol: emptyToNull(row.baseToken.symbol),
    quoteTokenAddress: quote,
    quoteTokenSymbol: emptyToNull(row.quoteToken.symbol),
    dexId: emptyToNull(row.dexId),
    labels: row.labels,
    priceUsd: row.priceUsd,
    liquidityUsd: row.liquidityUsd,
    pairCreatedAtMs: row.pairCreatedAtMs,
    resolutionBasis,
    resolvedFromToken,
    searchWindowSize,
    fetchedAtMs: snapshot.fetchedAtMs,
  };
}

export interface ResolveDeepestPairOptions {
  readonly transport: DexScreenerTransport;
  readonly chainId: string;
  readonly tokenAddress: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Resolve a token address to the deepest pool of the provider's bounded search
 * window.
 *
 * "Deepest" means deepest among AT MOST 30 pools the provider chose to return,
 * and every caller echoes that. The search is chain-scoped so the window is
 * spent on the chain the caller asked about rather than on same-address forks.
 */
export async function resolveDeepestPair(
  options: ResolveDeepestPairOptions
): Promise<ResolvedPair> {
  const result = await searchPairs({
    query: options.tokenAddress,
    chainIds: [options.chainId],
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const nowMs = Date.now();
  let best: { readonly address: string; readonly liquidityUsd: number } | null =
    null;
  let fallback: string | null = null;
  // The CANDIDATE count, not the window size. The window is a relevance
  // window: it holds at most 30 rows for the whole query, and only some of
  // them are this token's pools. Reporting `result.rows.length` made the
  // answer say "the deepest of the 30 pools" when the window held 30 rows of
  // which 22 were this token's (measured live on PEPE/ethereum). The sibling
  // `token_pairs_list` already models this as `matchedInWindow`.
  let matchedInWindow = 0;
  for (const raw of result.rows) {
    const row = projectPairRow(raw, { window: "h24", nowMs });
    if (row.chainId.toLowerCase() !== options.chainId.toLowerCase()) continue;
    if (
      row.baseToken.address.toLowerCase() !== options.tokenAddress.toLowerCase()
    ) {
      continue;
    }
    matchedInWindow += 1;
    fallback ??= row.pairAddress;
    // A row with no liquidity figure cannot win a depth comparison, but it can
    // still answer when nothing else does; it is kept as the fallback rather
    // than treated as zero liquidity.
    if (row.liquidityUsd === null) continue;
    if (best === null || row.liquidityUsd > best.liquidityUsd) {
      best = { address: row.pairAddress, liquidityUsd: row.liquidityUsd };
    }
  }

  const chosen = best?.address ?? fallback;
  if (chosen === null) {
    throw siteError(
      DexScreenerSiteErrorCodes.PAIR_NOT_RESOLVED,
      `No pool with base token ${options.tokenAddress} appeared in the ${result.rows.length} rows the provider's search window returned for chain ${options.chainId}`,
      `The window is bounded at ${SEARCH_PROVIDER_WINDOW} rows with no continuation, so this is not proof the token has no pools. Check the address and chain, or pass pairAddress directly.`
    );
  }
  return {
    pairAddress: chosen,
    windowSize: result.rows.length,
    matchedInWindow,
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}
