/**
 * Pendle READ-SURFACE client (multichain, KEYLESS) — seven documented read
 * endpoints the money-path client does not touch:
 *
 *   GET /v2/markets/all                                     → market catalogue (incl. MATURED)
 *   GET /v1/sdk/{chainId}/markets/{market}/tokens            → accepted token sets
 *   GET /v1/sdk/{chainId}/markets/{market}/swapping-prices   → live PT/YT rates
 *   GET /v3/{chainId}/markets/{market}/historical-data       → APY/TVL/price series
 *   GET /v4/{chainId}/prices/{asset}/ohlcv                   → candles (CSV in JSON)
 *   GET /v1/prices/assets                                    → USD snapshot map
 *   GET /v1/dashboard/merkle-rewards/{user}                  → reward accruals (read-only)
 *   GET /v2/limit-orders/book/{chainId}                      → limit-order depth
 *
 * SEPARATE FROM `tools/pendle/client.ts` BY DESIGN. That client is the money
 * path: its five endpoints back valuation, sizing and convert, and its
 * validators, CU table and TTLs are frozen for this tranche. Nothing here is
 * allowed to widen them, and nothing here is consumed by a mutating handler.
 *
 * ── KNOWN GAP, must be closed before these reads go live (R2) ──────────────
 * This client runs its OWN CU bucket because the money-path client builds its
 * throttle privately and cannot be reached without editing a frozen file. Two
 * buckets against ONE per-IP budget is over-subscription: the money lane
 * self-caps at 90 CU/min against a public 100, so this lane is capped at 10 to
 * keep the SUM at the documented ceiling. That is deliberately conservative and
 * deliberately slow. The real fix, when R2 wires these reads to handlers, is one
 * shared bucket — `PendleClient` taking an injected `PendleThrottle` so
 * `getPendleClient()` and `getPendleReadClient()` share one — and the split
 * below should be deleted, not re-tuned.
 *
 * The upstream error body is HOSTILE input: it is never read for text and never
 * reaches a thrown message (see `./errors.ts`). Singleton via
 * `getPendleReadClient()`.
 */

import { loadConfig } from "../../../config/store.js";
import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import logger from "../../../utils/logger.js";
import { PendleThrottle, parseRetryAfterMs } from "../throttle.js";
import { mapPendleReadError, mapPendleReadTransportError } from "./errors.js";
import { validatePendleMarketPage } from "./validation/market-catalog.js";
import {
  validatePendleMarketHistory,
  validatePendleMarketTokens,
  validatePendleSwappingPrices,
} from "./validation/market-detail.js";
import { validatePendleAssetPrices, validatePendleCandles } from "./validation/price-series.js";
import { validatePendleDashboardPositions } from "./validation/dashboard.js";
import { validatePendleMerkleRewards } from "./validation/merkle-rewards.js";
import { validatePendleOrderbook } from "./validation/orderbook.js";
import {
  PENDLE_READ_DEFAULT_MAX_PAGES,
  clampPageLimit,
  requireHistoryFields,
  requireOrderbookPrecision,
  requirePathAddress,
  requirePathChainId,
  type PendleReadAssetPriceQuery,
  type PendleReadCandleQuery,
  type PendleReadHistoryQuery,
  type PendleReadMarketQuery,
  type PendleReadOrderbookQuery,
  type PendleReadPositionsQuery,
} from "./request.js";
import type { PendleReadDashboardPositions } from "./dashboard-types.js";
import type {
  PendleReadAssetPrices,
  PendleReadCandles,
  PendleReadMarketCatalog,
  PendleReadMarketHistory,
  PendleReadMarketPage,
  PendleReadMarketTokens,
  PendleReadMerkleRewards,
  PendleReadOrderbook,
  PendleReadSwappingPrices,
} from "./types.js";

const USER_AGENT = "Vex-Agent/1.0 (+https://vexlabs.ai)";

/** See the module header: the money lane's 90 plus this 10 is the public ceiling. */
const READ_CU_PER_MINUTE = 10;

/**
 * Compute-unit cost per read, MEASURED from the live `x-computing-unit` response
 * header on 2026-07-27 — not assumed. (The money lane's table once carried an
 * assumed 3 where the header said 4.)
 *
 * `history` varies with how many fields are selected: 1 CU for a three-field
 * window, 4 CU for the default set. The higher figure is used so the bucket is
 * never under-charged. `includeFeeBreakdown` doubles it again and is out of
 * scope here.
 */
const PENDLE_READ_CU = {
  markets: 2,
  marketTokens: 1,
  swappingPrices: 1,
  history: 4,
  candles: 1,
  assetPrices: 1,
  merkleRewards: 4,
  orderbook: 5,
  walletPositions: 4,
} as const;

/**
 * Per-endpoint cache TTLs. Rates and books are near-real-time reads, so they get
 * the short TTL; catalogues and history move slowly.
 */
const PENDLE_READ_TTL = {
  markets: 60_000,
  marketTokens: 300_000,
  swappingPrices: 15_000,
  history: 300_000,
  candles: 300_000,
  assetPrices: 15_000,
  merkleRewards: 300_000,
  orderbook: 15_000,
  /**
   * Matches the money lane's positions TTL. Caching longer would be false
   * economy: the provider's own `updatedAt` is already the dominant staleness,
   * and a consumer must surface that rather than have us add to it.
   */
  walletPositions: 30_000,
} as const;

export class PendleReadClient {
  /**
   * The throttle is INJECTABLE, for two reasons: tests must not wait on a real
   * CU budget, and it is the seam R2 needs to collapse this lane's bucket into
   * the money lane's (see the module header).
   */
  constructor(
    private readonly baseUrl: string,
    private readonly throttle: PendleThrottle = new PendleThrottle({ cuPerMinute: READ_CU_PER_MINUTE }),
  ) {}

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value.length > 0) url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /** GET through cache → in-flight dedupe → CU throttle, then the strict validator. */
  private async get<T>(
    path: string,
    endpoint: string,
    cost: number,
    ttlMs: number,
    validator: (raw: unknown) => T,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    try {
      return await this.throttle.run(url, cost, ttlMs, async () => {
        const response = await fetchWithTimeout(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        });
        if (!response.ok) {
          if (response.status === 429) {
            this.throttle.penalize(parseRetryAfterMs(response.headers?.get?.("retry-after")));
          }
          const raw = await readJson(response);
          logger.warn("pendle.read.http_error", {
            status: response.status,
            endpoint,
            detail: raw === null ? null : JSON.stringify(raw).slice(0, 200),
          });
          throw mapPendleReadError(response.status, endpoint);
        }
        return validator(await readJson(response));
      });
    } catch (err) {
      mapPendleReadTransportError(err);
    }
  }

  /**
   * One page of `/v2/markets/all`.
   *
   * Two omissions carry meaning. Omitting `isActive` returns active AND matured
   * markets in one list — the property that makes this endpoint, and not the
   * money path's active-only one, the read lane's market source. Omitting
   * `chainId` returns every chain in one call.
   */
  async getMarketPage(query: PendleReadMarketQuery = {}): Promise<PendleReadMarketPage> {
    const limit = clampPageLimit(query.limit);
    const direction = query.sortDirection === "asc" ? "1" : "-1";
    return this.get(
      "/v2/markets/all",
      "markets",
      PENDLE_READ_CU.markets,
      PENDLE_READ_TTL.markets,
      validatePendleMarketPage,
      {
        chainId: query.chainId === undefined ? undefined : requirePathChainId(query.chainId),
        isActive: query.isActive === undefined ? undefined : String(query.isActive),
        ids: query.ids !== undefined && query.ids.length > 0 ? query.ids.join(",") : undefined,
        order_by: query.sortBy === undefined ? undefined : `${query.sortBy}:${direction}`,
        skip: String(query.skip ?? 0),
        limit: String(limit),
      },
    );
  }

  /**
   * Walk `/v2/markets/all` to exhaustion, or to `maxPages`, whichever comes
   * first. `complete` reports which one happened: an incomplete catalogue must
   * never be read as "the market is not there" (rules/90 — refuse rather than
   * guess), and it is never silently trimmed.
   */
  async listMarkets(
    query: PendleReadMarketQuery = {},
    maxPages: number = PENDLE_READ_DEFAULT_MAX_PAGES,
  ): Promise<PendleReadMarketCatalog> {
    const pageLimit = clampPageLimit(query.limit);
    const markets: PendleReadMarketPage["results"] = [];
    let skip = query.skip ?? 0;
    let total = 0;
    let pagesFetched = 0;
    let exhausted = false;

    while (pagesFetched < maxPages && !exhausted) {
      const page = await this.getMarketPage({ ...query, skip, limit: pageLimit });
      pagesFetched += 1;
      total = page.total;
      markets.push(...page.results);
      // Paging arithmetic uses the provider's OWN echoed offset and our page
      // size, never the row count we kept: a row the validator dropped would
      // otherwise shift the next offset and re-fetch what we already had, and a
      // caller-supplied starting `skip` would make the walk look incomplete
      // when it had in fact reached the end.
      skip = page.skip + pageLimit;
      // An empty page ends the walk without proving exhaustion — looping on it
      // would spend compute units forever.
      if (page.results.length === 0) break;
      exhausted = skip >= total;
    }

    return { markets, total, complete: exhausted, pagesFetched };
  }

  /** Token sets a market accepts. Served for matured markets too (live-verified). */
  async getMarketTokens(chainId: number, market: string): Promise<PendleReadMarketTokens> {
    return this.get(
      `/v1/sdk/${requirePathChainId(chainId)}/markets/${requirePathAddress(market, "market")}/tokens`,
      "market tokens",
      PENDLE_READ_CU.marketTokens,
      PENDLE_READ_TTL.marketTokens,
      validatePendleMarketTokens,
    );
  }

  /**
   * Pendle's own real-time PT/YT rates — the pre-trade price source its docs
   * point at instead of a convert quote.
   *
   * A MATURED market answers HTTP 404 (`Given market is expired`), which surfaces
   * as `PENDLE_MARKET_NOT_FOUND` carrying `httpStatus: 404`. That is a definitive
   * provider verdict, not a transport failure, and callers must report it as one.
   */
  async getSwappingPrices(chainId: number, market: string): Promise<PendleReadSwappingPrices> {
    return this.get(
      `/v1/sdk/${requirePathChainId(chainId)}/markets/${requirePathAddress(market, "market")}/swapping-prices`,
      "market swapping-prices",
      PENDLE_READ_CU.swappingPrices,
      PENDLE_READ_TTL.swappingPrices,
      validatePendleSwappingPrices,
    );
  }

  /** APY / TVL / price series for one market over an explicit window. */
  async getMarketHistory(
    chainId: number,
    market: string,
    query: PendleReadHistoryQuery,
  ): Promise<PendleReadMarketHistory> {
    const fields = requireHistoryFields(query.fields);
    return this.get(
      `/v3/${requirePathChainId(chainId)}/markets/${requirePathAddress(market, "market")}/historical-data`,
      "market historical-data",
      PENDLE_READ_CU.history,
      PENDLE_READ_TTL.history,
      (raw) => validatePendleMarketHistory(raw, fields),
      {
        time_frame: query.timeFrame,
        fields: fields.join(","),
        timestamp_start: query.timestampStart,
        timestamp_end: query.timestampEnd,
      },
    );
  }

  /**
   * OHLCV candles for a PT / YT / LP asset. The provider ships them as a CSV
   * string inside the JSON body; the validator decodes it under a hard row cap
   * and reports truncation explicitly.
   */
  async getAssetCandles(chainId: number, asset: string, query: PendleReadCandleQuery): Promise<PendleReadCandles> {
    return this.get(
      `/v4/${requirePathChainId(chainId)}/prices/${requirePathAddress(asset, "asset")}/ohlcv`,
      "asset ohlcv",
      PENDLE_READ_CU.candles,
      PENDLE_READ_TTL.candles,
      validatePendleCandles,
      {
        time_frame: query.timeFrame,
        timestamp_start: query.timestampStart,
        timestamp_end: query.timestampEnd,
      },
    );
  }

  /** USD snapshot for Pendle assets, filtered by chain, ids and/or asset class. */
  async getAssetPrices(query: PendleReadAssetPriceQuery = {}): Promise<PendleReadAssetPrices> {
    return this.get(
      "/v1/prices/assets",
      "asset prices",
      PENDLE_READ_CU.assetPrices,
      PENDLE_READ_TTL.assetPrices,
      validatePendleAssetPrices,
      {
        chainId: query.chainId === undefined ? undefined : requirePathChainId(query.chainId),
        ids: query.ids !== undefined && query.ids.length > 0 ? query.ids.join(",") : undefined,
        type: query.types !== undefined && query.types.length > 0 ? query.types.join(",") : undefined,
        skip: query.skip === undefined ? undefined : String(query.skip),
        limit: query.limit === undefined ? undefined : String(query.limit),
      },
    );
  }

  /**
   * Every Pendle position the dashboard knows for one wallet — PT, YT, LP, SY
   * and cross-chain PT legs, with accrued amounts, the LP staked split, and the
   * per-chain `updatedAt` that says how old all of it is.
   *
   * This is the SAME endpoint the money path reads; the difference is entirely
   * in what survives validation. Nothing here is consumed financially.
   */
  async getWalletPositions(
    wallet: string,
    query: PendleReadPositionsQuery = {},
  ): Promise<PendleReadDashboardPositions> {
    return this.get(
      `/v1/dashboard/positions/database/${requirePathAddress(wallet, "wallet")}`,
      "dashboard positions",
      PENDLE_READ_CU.walletPositions,
      PENDLE_READ_TTL.walletPositions,
      validatePendleDashboardPositions,
      { filterUsd: query.minUsd === undefined ? undefined : String(query.minUsd) },
    );
  }

  /**
   * Merkle-distributed reward accruals for a wallet. READ ONLY, and not by
   * policy alone: the endpoint returns no merkle proof and no verify calldata
   * (live-probed 2026-07-27), so no claim transaction can be built from it.
   */
  async getMerkleRewards(wallet: string): Promise<PendleReadMerkleRewards> {
    return this.get(
      `/v1/dashboard/merkle-rewards/${requirePathAddress(wallet, "wallet")}`,
      "merkle rewards",
      PENDLE_READ_CU.merkleRewards,
      PENDLE_READ_TTL.merkleRewards,
      validatePendleMerkleRewards,
    );
  }

  /**
   * Limit-order depth for one market. `precisionDecimal` is provider-required
   * and bounded 0-3.
   *
   * A market that is not limit-order whitelisted answers HTTP 404, not an empty
   * book — so an empty result here means "whitelisted, nothing resting".
   */
  async getOrderbook(chainId: number, market: string, query: PendleReadOrderbookQuery): Promise<PendleReadOrderbook> {
    const precisionDecimal = requireOrderbookPrecision(query.precisionDecimal);
    return this.get(
      `/v2/limit-orders/book/${requirePathChainId(chainId)}`,
      "limit-order book",
      PENDLE_READ_CU.orderbook,
      PENDLE_READ_TTL.orderbook,
      validatePendleOrderbook,
      {
        market: requirePathAddress(market, "market"),
        precisionDecimal,
        includeAmm: query.includeAmm === true ? "true" : undefined,
      },
    );
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: PendleReadClient | null = null;
let cachedBaseUrl: string | null = null;

export function getPendleReadClient(): PendleReadClient {
  const baseUrl = loadConfig().services.pendleApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) return cachedClient;
  cachedClient = new PendleReadClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
