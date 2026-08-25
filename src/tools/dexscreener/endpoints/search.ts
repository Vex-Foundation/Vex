/**
 * The pair search endpoint.
 *
 * `https://io.dexscreener.com/dex/search/v12/pairs?q={q}[&chainId={chain}]`
 *
 * Plain HTTP, protobuf body (the host claims `application/json` and is lying,
 * as everywhere on `io.dexscreener.com`), decoded as
 * `dex_search.SearchPairsResponse`, whose only field is a list of the same
 * `dex_screener_schema.Pair` rows the screener channels carry. That is why the
 * whole screening projection applies unchanged.
 *
 * FOUR MEASURED FACTS, EACH OF WHICH CHANGES WHAT A TOOL MAY CLAIM:
 *
 *  1. THE WINDOW IS 30 ROWS AND THERE IS NO CONTINUATION. Text queries and
 *     EXACT ADDRESS queries alike: WETH and wrapped-SOL by address both came
 *     back capped at 30. The plan's earlier "every pair of that token" is
 *     false and is withdrawn. A caller reports `providerCapped` and tells the
 *     agent to narrow; it must not offer a page that cannot exist.
 *  2. `chainId` IS HONOURED SERVER-SIDE. One chain narrows the search on the
 *     provider, which is the capability the public API does not have at all.
 *  3. `page`, `offset`, `limit` AND `dexId` ARE IGNORED. Measured: none of
 *     them changed the returned address window on a chain-scoped PEPE query.
 *     They are therefore NEVER SENT. Sending a parameter the provider ignores
 *     and reporting the unchanged answer as if it were narrowed is the exact
 *     failure the filter echo elsewhere in this surface exists to prevent.
 *  3b. THE QUERY GRAMMAR IS FUZZY, AND TWO OF ITS RULES ARE TRAPS. Measured
 *     2026-08-25. A DOUBLE QUOTE KILLS THE QUERY: `q="pepe"` answers HTTP 200
 *     with a ZERO-BYTE body, so a quoted phrase reads downstream as "nothing
 *     matches" rather than as an unsupported grammar. There is no quoted-phrase
 *     syntax and the quote is not stripped. MULTI-WORD IS OR, NOT AND:
 *     `q=pepe wif hat` returns 30 rows across six chains, including rows that
 *     match only one of the three words. Neither rule is guessable from the
 *     answer shape, so both are written into the tool's `query` description.
 *  4. SEVERAL CHAINS MEAN SEVERAL REQUESTS. Because the window is bounded per
 *     request and applied BEFORE we ever see it, filtering one global 30-row
 *     window client-side cannot find rows the provider never sent. Each chain
 *     is one bounded request, issued sequentially, and every request is
 *     reported. How MANY chains one call may name is the tool's policy, not
 *     this module's.
 *
 * ISSUER TEXT ARRIVES UNBOUNDED HERE, and this is the endpoint that proved it:
 * one live row on 2026-08-25 carried a 34,090-character `baseToken.name` and a
 * 9,575-character `symbol`, and the 30-row window projected to 91,531 bytes of
 * JSON. The transport cap (`SEARCH_MAX_BYTES`) bounds the DOCUMENT and is not
 * that bound. The per-field REPORTING bound lives in `../sanitize.ts` and is
 * applied by the tool that assembles rows, because only the assembler can name
 * the field path it bounded on the row it emitted.
 *
 * DECLARED OMISSIONS on the row shape this endpoint serves: `isBoostable` and
 * `isDEXFeedStreamEnabled` are present on 30 of 30 live rows and are not
 * projected; both are UI capability flags rather than market facts, and the
 * reasons are written out once in `./pair-live.ts`, which serves the same
 * `dex_screener_schema.Pair`. `liquidity.base` and `liquidity.quote` ARE
 * projected by the shared screening projection.
 */

import { decodeDexScreenerMessageToJson } from "../codec/protobuf.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import { mapDexScreenerError } from "../errors.js";
import { parseRetryAfterMs } from "../throttle.js";
import type { DexScreenerTransport } from "../transport.js";

/** The endpoint origin and path. */
export const DEXSCREENER_SEARCH_URL =
  "https://io.dexscreener.com/dex/search/v12/pairs";

/**
 * Rows the provider returns per request, at most.
 *
 * Not a Vex bound: measured on text queries and on exact address queries
 * alike. There is no parameter that raises it and no cursor that continues it.
 */
export const SEARCH_PROVIDER_WINDOW = 30;

/**
 * Chains one call fans out over when the caller names no bound.
 *
 * A DEFAULT, not a ceiling (plan 14.6 item 4, owner decision D-DS5). Each
 * chain costs one sequential provider request against a host we reach as a
 * browser user, so five keeps an unconfigured call to five requests; a caller
 * that wants more raises `maxChains` and the deadline is what bounds it. This
 * module no longer refuses a wide fan-out of its own accord: the bound is a
 * policy the tool owns, and enforcing it twice from two constants is how the
 * two spellings drift apart.
 */
export const SEARCH_DEFAULT_MAX_CHAINS = 5;

/** Shortest query the endpoint is asked with. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * Byte ceiling for one search response. A 30-row window measured 21,499 bytes
 * with full rows; two megabytes bounds it with ample room.
 */
export const SEARCH_MAX_BYTES = 2_000_000;

/** One chain's bounded answer. */
export interface SearchChainResult {
  /** The chain this request was scoped to, or null for an unscoped search. */
  readonly chainId: string | null;
  /** Raw `dex_screener_schema.Pair` rows, ready for `projectPairRow`. */
  readonly rows: readonly unknown[];
  /** True when the provider filled its window, so matches beyond it exist. */
  readonly providerCapped: boolean;
  readonly url: string;
  /**
   * The response headers of THIS request, for the caller's cache observation.
   * The edge answers this endpoint from Cloudflare, so `cf-cache-status` and
   * `age` are the only evidence of how stale the window is.
   */
  readonly responseHeaders: ReadonlyMap<string, string>;
  readonly fetchedAtMs: number;
}

export interface SearchResult {
  /** One entry per request issued, in the order they were issued. */
  readonly perChain: readonly SearchChainResult[];
  /** Every row across every request, in request order. */
  readonly rows: readonly unknown[];
  /** True when ANY request filled its window. */
  readonly providerCapped: boolean;
  /**
   * Headers of the LAST request issued, for the caller's one cache
   * observation.
   *
   * A fan-out has one set of headers per chain and they can disagree, so the
   * choice is stated rather than left implicit: the last request is the most
   * recent evidence about the edge at the moment this answer was assembled.
   * Every request's own headers stay reachable in `perChain`, so nothing is
   * lost by the summary.
   */
  readonly responseHeaders: ReadonlyMap<string, string>;
  readonly requestsIssued: number;
  readonly fetchedAtMs: number;
}

export interface SearchOptions {
  readonly query: string;
  /**
   * Chains to scope to. Empty or omitted issues ONE unscoped request across
   * every chain, which is a legitimate request and not a missing parameter.
   */
  readonly chainIds?: readonly string[];
  readonly transport: DexScreenerTransport;
  /** Hard deadline for ONE request, in milliseconds. Each chain gets its own. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Search, fanning out over the requested chains sequentially.
 *
 * Sequential rather than concurrent for the same reason the batch channel is:
 * these are browser-shaped requests against one host. The CALLER owns how wide
 * the fan-out may be (`maxChains` on the tool); the deadline and the abort
 * signal bound it here, and every request is reported in `perChain`.
 */
export async function searchPairs(
  options: SearchOptions
): Promise<SearchResult> {
  const query = options.query.trim();
  if (query.length < SEARCH_MIN_QUERY_LENGTH) {
    throw siteError(
      DexScreenerSiteErrorCodes.SEARCH_REQUEST_REFUSED,
      `"query" must be at least ${SEARCH_MIN_QUERY_LENGTH} characters; received ${query.length}`,
      "Search by token name, ticker symbol, or a full contract or pair address."
    );
  }

  const chains = options.chainIds ?? [];

  const targets: readonly (string | null)[] =
    chains.length === 0 ? [null] : chains;
  const perChain: SearchChainResult[] = [];
  for (const chainId of targets) {
    throwIfAborted(options.signal);
    perChain.push(await searchOneChain(query, chainId, options));
  }

  return {
    perChain,
    rows: perChain.flatMap((entry) => entry.rows),
    providerCapped: perChain.some((entry) => entry.providerCapped),
    responseHeaders:
      perChain[perChain.length - 1]?.responseHeaders ?? new Map<string, string>(),
    requestsIssued: perChain.length,
    fetchedAtMs: Date.now(),
  };
}

async function searchOneChain(
  query: string,
  chainId: string | null,
  options: SearchOptions
): Promise<SearchChainResult> {
  // Only `q` and `chainId` are ever sent. `page`, `offset`, `limit` and
  // `dexId` are measured ignored and are deliberately absent: a parameter the
  // provider drops would make the echo a lie.
  const params = new URLSearchParams({ q: query });
  if (chainId !== null) params.set("chainId", chainId);
  const url = `${DEXSCREENER_SEARCH_URL}?${params.toString()}`;

  const response = await options.transport.httpGet(url, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    maxBytes: SEARCH_MAX_BYTES,
  });
  // TWO FAILURE CLASSES, NOT ONE. A 4xx on this endpoint is the provider
  // refusing the request AS SPELLED and it is permanent: measured 2026-08-25,
  // `q=P` and `q=` and any bracketed parameter name each answer HTTP 400 with
  // a ZERO-BYTE body, identically, forever. Advising a retry on that (which
  // this module used to do for every non-200 alike) spends a second request to
  // receive the same refusal, and tells the agent the request was fine.
  // Anything else - 5xx, a redirect, an edge error - says nothing about the
  // request and is worth exactly one retry.
  // ...WITH TWO EXCEPTIONS INSIDE THE 4xx RANGE, WHICH ARE TRANSIENT AND ARE
  // NOT OWNED HERE. A 429 is a rate limit and a 408 is the provider timing out
  // on a request it never read; neither is a statement about the query, and
  // telling an agent "do not retry, change the query" for either is the
  // measured defect this branch had. The transient policy, its `Retry-After`
  // handling and its retryable flag already have an owner in
  // `../errors.ts`/`../throttle.ts`, so this routes to it rather than
  // restating it and creating a second source of truth.
  if (response.status === 429 || response.status === 408) {
    const error = mapDexScreenerError(response.status);
    const retryAfterMs = parseRetryAfterMs(
      response.headers.get("retry-after"),
      0
    );
    if (retryAfterMs > 0) {
      error.retryAfterSeconds = Math.ceil(retryAfterMs / 1_000);
    }
    throw error;
  }
  if (response.status >= 400 && response.status < 500) {
    throw siteError(
      DexScreenerSiteErrorCodes.SEARCH_REQUEST_REFUSED,
      `The DexScreener search endpoint REFUSED the request for ${chainId === null ? "an unscoped search" : `chain ${chainId}`} with HTTP ${response.status} and an empty body, which is how it rejects a query it will not parse`,
      `This is deterministic: the identical request will be refused identically, so do not retry it. Change the query itself. Measured causes: a query shorter than ${SEARCH_MIN_QUERY_LENGTH} characters, an empty query, and any bracketed parameter name. This is not evidence that nothing matches.`
    );
  }
  if (response.status !== 200) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_NO_RESULT_FRAME,
      `The DexScreener search endpoint answered HTTP ${response.status} for ${chainId === null ? "an unscoped search" : `chain ${chainId}`}`,
      "Retry once; a 5xx or transport-level answer here says nothing about the request and is not proof that nothing matches."
    );
  }

  const rows = parseSearchResponse(response.body);
  return {
    chainId,
    rows,
    providerCapped: rows.length >= SEARCH_PROVIDER_WINDOW,
    url,
    responseHeaders: response.headers,
    fetchedAtMs: Date.now(),
  };
}

/**
 * Decode one search response to its raw rows.
 *
 * Exported so the decode has a testable owner that needs no transport.
 */
export function parseSearchResponse(body: Uint8Array): readonly unknown[] {
  let json: unknown;
  try {
    json = decodeDexScreenerMessageToJson(
      "dex_search.SearchPairsResponse",
      body,
      { maxBytes: SEARCH_MAX_BYTES }
    );
  } catch (error) {
    if (
      isDexScreenerSiteError(error) &&
      error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
    ) {
      throw error;
    }
    throw siteError(
      DexScreenerSiteErrorCodes.DECODE_FAILED,
      `${body.byteLength} bytes from the search endpoint did not decode as dex_search.SearchPairsResponse`,
      "The wire format may have changed. Re-run the descriptor drift test before trusting this endpoint."
    );
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return [];
  }
  const pairs = (json as Record<string, unknown>)["pairs"];
  return Array.isArray(pairs) ? pairs : [];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw siteError(
    DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED,
    "The search was cancelled by the caller before the next chain request",
    "Nothing further was read; issue a new request if the result is still wanted."
  );
}
