/**
 * pools.fun REST API client (api.bankr.bot).
 *
 * Wraps the keyless public launchpad endpoints with typed, validated responses.
 * Singleton via `getPoolsFunClient()`, keyed on the configured base URL.
 *
 * TWO PARAMETERS ARE NOT NEGOTIABLE, and both are enforced structurally rather
 * than documented (probe HARD RULE 1):
 * - `chain=robinhood` is injected on EVERY call. Omitting it makes the provider
 *   answer for BASE, and the rows look like plausible Robinhood data.
 * - `platform` is a REQUIRED argument of every discover-family method. Omitting
 *   it makes the provider answer with Bankr/Doppler tokens from a third
 *   launchpad on the same chain, whose `poolId` is a Uniswap-V4 pool id rather
 *   than a pool address. There is no default and no way to leave it out.
 *
 * Other provider facts handled here:
 * - `limit` is capped at 100 on `/discover` and 1000 on the candles route; the
 *   client clamps so the caller's page math matches what actually comes back.
 * - Query keys are appended in a STABLE ORDER so a future cache/dedupe key over
 *   the URL is stable (trench convention).
 * - No auth, no documented rate limit, `cache-control: max-age=5` on discover.
 */

import { loadConfig } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { fetchWithTimeout } from "../../utils/http.js";
import {
  POOLS_CANDLE_LIMIT_CAP,
  POOLS_CHAIN_SLUG,
  POOLS_DISCOVER_LIMIT_CAP,
  POOLS_ENDPOINTS,
} from "./constants.js";
import { mapPoolsFunError, mapTransportError } from "./errors.js";
import type {
  PoolsCandles,
  PoolsCandlesParams,
  PoolsDevBuyQuote,
  PoolsDiscoverPage,
  PoolsDiscoverParams,
  PoolsHolderRewards,
  PoolsImageUpload,
  PoolsLaunchAssets,
  PoolsLaunchConfig,
  PoolsPrepareRequest,
  PoolsPrepareResponse,
} from "./types.js";
import {
  validateCandles,
  validateDevBuyQuote,
  validateDiscoverPage,
  validateHolderRewards,
  validateImageUpload,
  validateLaunchAssets,
  validateLaunchConfig,
  validatePrepareResponse,
} from "./validation.js";

/**
 * Query keys in the order they are appended. Kept as an explicit list rather
 * than object-key order so the URL a given request produces is stable no matter
 * how the caller built its params object.
 */
const DISCOVER_QUERY_ORDER = [
  "chain",
  "platform",
  "q",
  "sortBy",
  "order",
  "limit",
  "cursor",
  "live",
  "minMarketCap",
  "maxMarketCap",
  "volTimeframe",
  "minVol",
  "minTxCount24h",
  "maxAgeHours",
  "deployer",
  "feeRecipient",
  // Added 2026-09-04. Both are OPT-IN SWITCHES, not booleans: the provider
  // accepts the literal string "true" and answers `false` with HTTP 400
  // `Invalid input: expected "true"`, so the client sends the key only when the
  // filter is on (see `discover` below).
  "vexAttested",
  "holderRewards",
] as const;

const CANDLES_QUERY_ORDER = ["chain", "timeframe", "aggregate", "limit"] as const;

/** `/pools-fun/holder-rewards` query keys, in the order they are appended. */
const HOLDER_REWARDS_QUERY_ORDER = ["token", "wallet"] as const;

/**
 * Per-call options every endpoint accepts.
 *
 * `signal` is the turn's Operator-Stop signal, threaded from
 * `ProtocolExecutionContext.abortSignal`. It is a per-CALL argument rather than
 * client state because the client is a shared singleton: storing a signal on it
 * would let one turn's stop cancel another turn's in-flight read.
 */
export interface PoolsRequestOptions {
  readonly signal?: AbortSignal | undefined;
}

function clamp(limit: number | undefined, cap: number): number | undefined {
  if (limit === undefined) return undefined;
  return Math.max(1, Math.min(cap, Math.floor(limit)));
}

export class PoolsFunClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * Build `<base><path>?<query>` appending only supplied keys, in
   * `order`. One private builder keeps the query encoding - and therefore any
   * future cache key - in a single place with a deterministic key order.
   */
  private buildUrl(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    order: readonly string[],
  ): string {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    for (const key of order) {
      const value = query[key];
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Fetch + read-as-text, then parse. A non-ok status becomes a typed
   * `POOLS_*` error carrying the provider's own explanation; transport failures
   * are re-tagged once, here, at the boundary.
   */
  private async send(
    url: string,
    options: PoolsRequestOptions,
    init: RequestInit = {},
  ): Promise<unknown> {
    try {
      // The caller's Operator-Stop signal is COMPOSED with the request timeout
      // by `fetchWithTimeout`; passing it is what makes a stopped turn stop the
      // in-flight read rather than wait it out.
      const response = await fetchWithTimeout(url, {
        ...init,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const text = await response.text();

      if (!response.ok) {
        throw mapPoolsFunError(response.status, text);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new VexError(
          ErrorCodes.POOLS_INVALID_RESPONSE,
          "pools.fun returned a non-JSON body",
          "The launchpad API returned an unexpected response shape.",
        );
      }
    } catch (err) {
      mapTransportError(err);
    }
  }

  /**
   * `/discover` - the one list/filter/search endpoint behind `pools.tokens`,
   * `pools.search` and `pools.my_launches`.
   *
   * `params.platform` is required by the TYPE, which is the whole point: there
   * is no code path through this client that can ask the provider for "whatever
   * launchpad you feel like".
   */
  async discover(
    params: PoolsDiscoverParams,
    options: PoolsRequestOptions = {},
  ): Promise<PoolsDiscoverPage> {
    const url = this.buildUrl(
      POOLS_ENDPOINTS.discover,
      {
        chain: POOLS_CHAIN_SLUG,
        platform: params.platform,
        q: params.query,
        sortBy: params.sortBy,
        order: params.order,
        limit: clamp(params.limit, POOLS_DISCOVER_LIMIT_CAP),
        cursor: params.cursor,
        live: params.live,
        minMarketCap: params.minMarketCapUsd,
        maxMarketCap: params.maxMarketCapUsd,
        volTimeframe: params.volTimeframe,
        minVol: params.minVolUsd,
        minTxCount24h: params.minTxCount24h,
        maxAgeHours: params.maxAgeHours,
        deployer: params.deployerAddress,
        feeRecipient: params.feeRecipientAddress,
        // `true` or NOTHING. `vexAttested=false` is HTTP 400 on this provider
        // (`Invalid input: expected "true"`, measured 2026-09-04), so a caller
        // asking for `false` is asking for "do not apply the filter" and the
        // key is dropped rather than sent as a value the API rejects.
        vexAttested: params.vexAttested === true ? true : undefined,
        holderRewards: params.holderRewards === true ? true : undefined,
      },
      DISCOVER_QUERY_ORDER,
    );
    return validateDiscoverPage(await this.send(url, options));
  }

  /**
   * `/discover/{token}/ohlcv` - candles for ONE token.
   *
   * An unknown or pool-less token answers HTTP 502 "Upstream error resolving
   * token pool", which `errors.ts` turns into a named not-found rather than a
   * server fault.
   */
  async candles(
    params: PoolsCandlesParams,
    options: PoolsRequestOptions = {},
  ): Promise<PoolsCandles> {
    const url = this.buildUrl(
      POOLS_ENDPOINTS.ohlcv(params.tokenAddress),
      {
        chain: POOLS_CHAIN_SLUG,
        timeframe: params.timeframe,
        aggregate: params.aggregate,
        limit: clamp(params.limit, POOLS_CANDLE_LIMIT_CAP),
      },
      CANDLES_QUERY_ORDER,
    );
    return validateCandles(await this.send(url, options));
  }

  /**
   * `/pools-fun/launch-assets` - every tokenised stock a launch may pair
   * against.
   *
   * NO PAGINATION AND NO FILTERS. The provider returns the whole list in one
   * body (194 rows on 2026-09-04) and IGNORES a `chain` parameter - asking for
   * `chain=base` still answers with the Robinhood set - so nothing is appended
   * to the URL and there is no cursor to echo. Rows carry no decimals: a launch
   * that needs the pair's decimals reads them on-chain.
   */
  async launchAssets(options: PoolsRequestOptions = {}): Promise<PoolsLaunchAssets> {
    const url = new URL(POOLS_ENDPOINTS.launchAssets, this.base()).toString();
    return validateLaunchAssets(await this.send(url, options));
  }

  /**
   * `/pools-fun/holder-rewards?token=&wallet=` - the launchpad's view of one
   * fees-to-holders distributor, optionally for one holder.
   *
   * BOTH ADDRESSES ARE LOWERCASED BEFORE THEY ARE SENT, and that is a fix for a
   * measured provider fault rather than tidiness. A mixed-case address whose
   * EIP-55 checksum is WRONG makes this endpoint answer HTTP 502
   * `Could not load holder rewards` - not the HTTP 400 naming the field that a
   * malformed address gets - so a caller who copied a truncated address out of a
   * UI would see a server outage instead of a bad argument. Measured 2026-09-04:
   * the same wallet lowercased, and any correctly-checksummed mixed-case
   * address, answer 200. Lowercase is always checksum-valid, so normalising here
   * removes the failure mode entirely.
   *
   * The wallet leg is still NOT the money authority: `earned(wallet)` on the
   * distributor is (`holder-rewards/read.ts`, plan v3 A5). This value is the
   * provider's echo of it.
   *
   * Rate limited to 30 requests per 60 seconds (`ratelimit-policy: 30;w=60`).
   * A token with no distributor answers HTTP 404 `Not a fees-to-holders token`,
   * which `errors.ts` turns into a named not-found rather than a route error.
   */
  async holderRewards(
    params: { readonly tokenAddress: string; readonly walletAddress?: string | undefined },
    options: PoolsRequestOptions = {},
  ): Promise<PoolsHolderRewards> {
    const url = this.buildUrl(
      POOLS_ENDPOINTS.holderRewards,
      {
        token: params.tokenAddress.toLowerCase(),
        wallet: params.walletAddress?.toLowerCase(),
      },
      HOLDER_REWARDS_QUERY_ORDER,
    );
    return validateHolderRewards(await this.send(url, options));
  }

  // -- Launch preparation (gateway path) -----------------------------
  //
  // These three are POSTs and are NOT chain-scoped the way the reads are: the
  // gateway and its fee are the chain binding, and the verifier proves both
  // on-chain before anything is signed.

  /**
   * `/pools-fun/launches/config` - the gateway's CURRENT deployment fee.
   *
   * Read fresh at every prepare and again at execute. The fee is DYNAMIC: it
   * moved from 0.000263 to 0.00105 ETH inside 24 hours, so a value carried
   * from an earlier preview is a revert waiting to happen.
   */
  async launchConfig(options: PoolsRequestOptions = {}): Promise<PoolsLaunchConfig> {
    const url = new URL(POOLS_ENDPOINTS.launchConfig, this.base()).toString();
    return validateLaunchConfig(await this.send(url, options));
  }

  /**
   * `/pools-fun/launches/upload-image` - multipart, field name `file`.
   *
   * Note the path is under `/launches/`: `/pools-fun/upload-image` is a 404. A
   * JSON body is refused with HTTP 400 "Send the image as multipart/form-data".
   * Rate limited to roughly one call per minute, so callers upload ONCE and
   * reuse the returned URL across reprepares.
   */
  async uploadLaunchImage(
    image: { readonly bytes: Uint8Array; readonly fileName: string; readonly contentType: string },
    options: PoolsRequestOptions = {},
  ): Promise<PoolsImageUpload> {
    const form = new FormData();
    // `slice()` copies into a plain ArrayBuffer-backed view: a `Uint8Array` may
    // sit on a SharedArrayBuffer, which is not a valid `BlobPart`.
    form.append(
      "file",
      new Blob([image.bytes.slice()], { type: image.contentType }),
      image.fileName,
    );
    const url = new URL(POOLS_ENDPOINTS.uploadImage, this.base()).toString();
    return validateImageUpload(await this.send(url, options, { method: "POST", body: form }));
  }

  /**
   * `/pools-fun/launches/dev-buy-quote` - an INDICATIVE prebuy fill.
   *
   * Indicative only: it assumes a fresh pool at the initial FDV, and the
   * authoritative fill is the one an `eth_call` of the launch itself returns.
   * `devBuyMinOut` is pinned from THAT simulation, never from this quote.
   */
  async devBuyQuote(devBuyEth: string, options: PoolsRequestOptions = {}): Promise<PoolsDevBuyQuote> {
    const url = new URL(POOLS_ENDPOINTS.devBuyQuote, this.base()).toString();
    return validateDevBuyQuote(
      await this.send(url, options, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ devBuyEth }),
      }),
    );
  }

  /**
   * `/pools-fun/launches/prepare` - the backend mines the salt and returns
   * complete `Gateway.launch(tuple)` calldata.
   *
   * STATELESS ON-CHAIN, NOT SIDE-EFFECT FREE: every call pins a persistent IPFS
   * metadata object through the provider's account, so callers reprepare
   * deliberately rather than in a loop.
   *
   * Nothing in the response is trusted. It is input to the calldata verifier,
   * which re-derives every field from the decoded tuple and the chain.
   */
  async prepareLaunch(
    request: PoolsPrepareRequest,
    options: PoolsRequestOptions = {},
  ): Promise<PoolsPrepareResponse> {
    const url = new URL(POOLS_ENDPOINTS.prepareLaunch, this.base()).toString();
    return validatePrepareResponse(
      await this.send(url, options, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Undefined members are dropped by JSON.stringify, so an omitted
        // optional never reaches the provider as `null`.
        body: JSON.stringify(request),
      }),
    );
  }

  /** The base URL with a guaranteed trailing slash, for `new URL(path, base)`. */
  private base(): string {
    return this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
  }
}

// -- Singleton -------------------------------------------------------

let cachedClient: PoolsFunClient | null = null;
let cachedBaseUrl: string | null = null;

/** Shared client, rebuilt only when the configured base URL changes. */
export function getPoolsFunClient(): PoolsFunClient {
  const baseUrl = loadConfig().services.poolsFunApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) {
    return cachedClient;
  }
  cachedClient = new PoolsFunClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
