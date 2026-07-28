/**
 * Pendle v2 hosted-API client (multichain, KEYLESS).
 *
 * Five endpoints back the fixed-yield PT tools:
 *   - GET  /v1/{chainId}/markets/active              → discovery / valuation
 *   - GET  /v1/{chainId}/assets/all                  → metadata + prices (cache 5m)
 *   - GET  /v1/dashboard/positions/database/{wallet} → session-wallet positions
 *   - GET  /v1/sdk/{chainId}/supported-aggregators   → per-chain aggregator gate
 *   - POST /v3/sdk/{chainId}/convert                 → mutating quote/plan (201 = ok)
 *
 * CONTRACT CHANGE (H-1, 2026-07-27) — assets are now PER-CHAIN.
 * `getAllAssets()` (global `/v1/assets/all`) is GONE, replaced by
 * `getAssetsForChain(chainId)`. The two endpoints are not interchangeable:
 * the global root is an object `{assets:[…]}` whose rows carry NO `price` and NO
 * `baseType`, while the per-chain root is a bare array whose rows carry both.
 * Reading the global one through an array-shaped validator made `getAllAssets()`
 * return `[]` on every call in production — silently. Every caller that used to
 * take the global list and filter it by `chainId` must now pass the chain in.
 * Cost: N chains = N calls where there was one; each is 1 CU and TTL-cached 5m
 * per chain URL, and callers only ask for chains they are actually working on.
 *
 * Markets, assets and convert are chainId-scoped; positions are GLOBAL. All
 * reads are CU-throttled + TTL-cached (URL-keyed, so per-chain caches come
 * free); convert is throttled but NEVER cached (each plan must be fresh).
 *
 * Aggregators: the convert body sends the INTERSECTION of PENDLE_AGGREGATORS
 * (kyberswap/okx) with the chain's supported set (some chains support only
 * kyberswap), falling back to `["kyberswap"]` when the support fetch fails.
 * `useLimitOrder` is FALSE (live-probed: the server defaults it to true, which
 * would inject limit-order fills and widen the safety-decode surface).
 *
 * The upstream error body is HOSTILE input — it is logged as bounded metadata
 * only and NEVER copied into the thrown (model-facing) error. Singleton via
 * `getPendleClient()`.
 */

import { loadConfig } from "../../config/store.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import logger from "../../utils/logger.js";
import { mapPendleError, mapPendleTransportError } from "./errors.js";
import { PendleThrottle, PENDLE_TTL, PENDLE_CU, parseRetryAfterMs } from "./throttle.js";
import { PENDLE_AGGREGATORS } from "./constants.js";
import {
  validateAssets,
  validateClaim,
  validateConvert,
  validateMarkets,
  validatePositions,
  validateSupportedAggregators,
} from "./validation.js";
import type {
  PendleAsset,
  PendleClaimResponse,
  PendleConvertResponse,
  PendleMarket,
  PendleTokenAmount,
  PendleUserPositions,
} from "./types.js";

const USER_AGENT = "Vex-Agent/1.0 (+https://vexlabs.ai)";

export interface PendleConvertParams {
  receiver: string;
  input: PendleTokenAmount;
  /** Output token address. */
  outputToken: string;
  /** Slippage tolerance 0-1 (0.01 = 1%). */
  slippage: number;
}

/**
 * Multi-leg convert (PY mint / pre-expiry PY redeem). Convert expresses these as
 * MULTIPLE inputs and/or outputs:
 *   - mint-py   : inputs `[{token}]`, outputs `[pt, yt]` (server returns action
 *                 `mint-py` + `mintPyFromToken`; a single `[pt]` output would be a
 *                 plain swap instead — live-verified),
 *   - redeem-py : inputs `[pt, yt]` (EQUAL amounts), outputs `[token]` (action
 *                 `redeem-py` + `redeemPyToToken`).
 * Same throttle/dedupe/error path as the single-leg `convert`.
 */
export interface PendleConvertMultiParams {
  receiver: string;
  inputs: PendleTokenAmount[];
  /** Output token addresses. */
  outputs: string[];
  /** Slippage tolerance 0-1 (0.01 = 1%). */
  slippage: number;
}

export class PendleClient {
  private readonly throttle: PendleThrottle;

  constructor(private readonly baseUrl: string) {
    this.throttle = new PendleThrottle();
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value.length > 0) url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /** GET through cache → dedupe → CU throttle. */
  private async get<T>(
    path: string,
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
          logger.warn("pendle.api.http_error", {
            status: response.status,
            path,
            detail: raw === null ? null : JSON.stringify(raw).slice(0, 200),
          });
          throw mapPendleError(response.status, raw);
        }
        return validator(await readJson(response));
      });
    } catch (err) {
      mapPendleTransportError(err);
    }
  }

  /** Active markets on one chain (discovery + valuation source). */
  getActiveMarkets(chainId: number): Promise<PendleMarket[]> {
    return this.get(`/v1/${chainId}/markets/active`, PENDLE_CU.markets, PENDLE_TTL.markets, validateMarkets);
  }

  /**
   * MATURED markets on one chain — the sibling of `getActiveMarkets`, and the
   * only new fetch R5b needs to make a matured PT redeemable (G-02 / D18).
   *
   * Same envelope, same row shape, so `validateMarkets` applies VERBATIM.
   * LIVE-VERIFIED 2026-07-27 on chain 1: `{markets:[…]}` with 420 rows whose key
   * set matches the active endpoint's, and 420/420 carrying a parseable past
   * expiry (zero missing, zero unparseable, zero future).
   *
   * ENDPOINT CHOICE, and what it does NOT decide. This uses the same
   * `/v1/{chainId}/…` family the money path already depends on for
   * `markets/active`, so the R5b change adds no NEW class of dependency. Both
   * that endpoint and this one are absent from the published OpenAPI
   * enumeration (gap G-03), and whether the money path should migrate to the
   * documented `/v2/markets/all` — which has a DIFFERENT envelope and would move
   * the active path too — remains an OPEN OWNER QUESTION for F-3. This method
   * deliberately does not pre-empt it: it keeps the two market fetches on the
   * same footing so they can be migrated together, in one decision.
   *
   * Note the read lane answers the same question from the documented catalogue
   * (`market-read.ts` → `/v2/markets/all`). That is not duplication to collapse:
   * the read lane must never feed a money path, and this one must never feed a
   * read, which is why they hold separate clients and separate types.
   */
  getInactiveMarkets(chainId: number): Promise<PendleMarket[]> {
    return this.get(`/v1/${chainId}/markets/inactive`, PENDLE_CU.markets, PENDLE_TTL.markets, validateMarkets);
  }

  /**
   * One chain's Pendle assets (metadata + prices + `baseType`). Cached per chain
   * URL (5m). A shape we cannot read RAISES `PENDLE_INVALID_RESPONSE` — callers
   * must treat that as "unknown", never as "this chain has no assets".
   */
  getAssetsForChain(chainId: number): Promise<PendleAsset[]> {
    return this.get(`/v1/${chainId}/assets/all`, PENDLE_CU.assets, PENDLE_TTL.assets, validateAssets);
  }

  /**
   * Aggregators the chain's Convert supports. TTL-cached 1h + CU-throttled. A
   * failing/odd response degrades to `[]` (via the tolerant validator); the
   * caller then falls back to kyberswap.
   */
  getSupportedAggregators(chainId: number): Promise<string[]> {
    return this.get(
      `/v1/sdk/${chainId}/supported-aggregators`,
      PENDLE_CU.aggregators,
      PENDLE_TTL.aggregators,
      validateSupportedAggregators,
    );
  }

  /**
   * The aggregators the convert body should carry for `chainId`: the intersection
   * of PENDLE_AGGREGATORS with the chain's supported set. Falls back to
   * `["kyberswap"]` when the support fetch fails OR the intersection is empty, so
   * a chain that only supports kyberswap NEVER receives okx.
   */
  private async resolveAggregators(chainId: number): Promise<string[]> {
    let supported: string[];
    try {
      supported = await this.getSupportedAggregators(chainId);
    } catch {
      logger.warn("pendle.api.aggregators_unavailable", { chainId, reason: "fetch_failed" });
      return ["kyberswap"];
    }
    const allowed = new Set(supported);
    const intersection = PENDLE_AGGREGATORS.filter((a) => allowed.has(a));
    if (intersection.length === 0) {
      // Never silent: an empty intersection means we route every trade on this
      // chain through kyberswap alone, which is a measurable execution cost.
      logger.warn("pendle.api.aggregators_unavailable", { chainId, reason: "empty_intersection", supported: supported.length });
      return ["kyberswap"];
    }
    return intersection;
  }

  /** Dashboard positions for one wallet (valuation included per leg). */
  getPositions(wallet: string): Promise<PendleUserPositions[]> {
    return this.get(
      `/v1/dashboard/positions/database/${encodeURIComponent(wallet)}`,
      PENDLE_CU.positions,
      PENDLE_TTL.positions,
      validatePositions,
    );
  }

  /**
   * Build a single income-sweep tx that claims accrued YT interest + rewards and
   * LP rewards for `yts` / `markets` on `chainId`. The hosted SDK PRUNES the
   * lists to what is actually claimable, so the returned tx sweeps a SUBSET of
   * the passed sets. NEVER cached (mutating). Returns null when there is no
   * usable tx. The tool binds the result via `assertClaimSafe` before signing —
   * we never pass a `tokensOut`/swap, so the response carries no external swap.
   */
  redeemInterestsAndRewards(
    chainId: number,
    params: { receiver: string; yts: readonly string[]; markets: readonly string[] },
  ): Promise<PendleClaimResponse | null> {
    return this.get(
      `/v1/sdk/${chainId}/redeem-interests-and-rewards`,
      PENDLE_CU.claim,
      PENDLE_TTL.claim,
      validateClaim,
      {
        receiver: params.receiver,
        yts: params.yts.length > 0 ? params.yts.join(",") : undefined,
        markets: params.markets.length > 0 ? params.markets.join(",") : undefined,
      },
    );
  }

  /**
   * POST convert on `chainId` — build a mutating quote/broadcast plan. NEVER
   * cached; still CU-throttled + in-flight-deduped. Aggregators are the per-chain
   * intersection of PENDLE_AGGREGATORS with the chain's supported set;
   * `useLimitOrder` false (load-bearing). Returns null when the body has no
   * usable route.
   */
  async convert(chainId: number, params: PendleConvertParams): Promise<PendleConvertResponse | null> {
    return this.convertMulti(chainId, {
      receiver: params.receiver,
      inputs: [params.input],
      outputs: [params.outputToken],
      slippage: params.slippage,
    });
  }

  /**
   * Multi-leg convert — the single code path for mint-py (one input → PT+YT) and
   * pre-expiry redeem-py (PT+YT → one output). Identical throttle/dedupe/error
   * handling to `convert`; only the inputs/outputs arity differs.
   *
   * R5d NEEDED NO CHANGE HERE, and that is a finding rather than an omission.
   * Convert has no `action` parameter: the server INFERS the action from the
   * input/output token shape, so all six new write actions are reachable through
   * this one method with the EXACT same closed body key set that
   * `convert-body-keys.test.ts` pins. Live-probed 2026-07-28, all HTTP 201:
   *
   *   mint-sy               inputs `[token]`      outputs `[SY]`
   *   redeem-sy             inputs `[SY]`         outputs `[token]`
   *   remove-liquidity-dual inputs `[LP]`         outputs `[token, PT]`
   *   add-liquidity keep-YT inputs `[token]`      outputs `[LP, YT]`
   *   roll-over-pt          inputs `[PT(mktA)]`   outputs `[PT(mktB)]`
   *   transfer-liquidity    inputs `[LP(mktA)]`   outputs `[LP(mktB)]`
   *   convert-lp-to-pt      inputs `[LP]`         outputs `[PT]`
   *
   * Adding a per-action wrapper method would be API surface with no behaviour
   * behind it. Callers pass the token shape; the closed body stays closed.
   *
   * The RESPONSE's `outputs` order is the provider's own and does NOT echo the
   * order requested here (measured both ways on the two dual actions) — never
   * read a leg out of it positionally; see `calldata/price-floor.ts`.
   */
  async convertMulti(chainId: number, params: PendleConvertMultiParams): Promise<PendleConvertResponse | null> {
    const url = this.buildUrl(`/v3/sdk/${chainId}/convert`);
    const body = {
      receiver: params.receiver,
      slippage: params.slippage,
      inputs: params.inputs,
      outputs: params.outputs,
      enableAggregator: true,
      aggregators: await this.resolveAggregators(chainId),
      useLimitOrder: false,
    };
    // Dedupe key includes the body so identical concurrent converts share a call.
    const key = `${url}#${JSON.stringify(body)}`;
    try {
      return await this.throttle.run(key, PENDLE_CU.convert, PENDLE_TTL.convert, async () => {
        const response = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          if (response.status === 429) {
            this.throttle.penalize(parseRetryAfterMs(response.headers?.get?.("retry-after")));
          }
          const raw = await readJson(response);
          logger.warn("pendle.api.http_error", {
            status: response.status,
            path: "/v3/sdk/convert",
            detail: raw === null ? null : JSON.stringify(raw).slice(0, 200),
          });
          throw mapPendleError(response.status, raw);
        }
        return validateConvert(await readJson(response));
      });
    } catch (err) {
      mapPendleTransportError(err);
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: PendleClient | null = null;
let cachedBaseUrl: string | null = null;

export function getPendleClient(): PendleClient {
  const baseUrl = loadConfig().services.pendleApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) return cachedClient;
  cachedClient = new PendleClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
