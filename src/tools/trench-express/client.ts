/**
 * Trench Express REST API client.
 *
 * Wraps the keyless public launchpad endpoints with typed, validated responses.
 * Singleton via `getTrenchExpressClient()`, keyed on the configured base URL.
 *
 * Provider quirks handled here (all proven by live probes — see `TrenchExpress.md`):
 * - Params travel as ONE URL-encoded JSON blob (`?params={…}`). `buildUrl`
 *   serializes with STABLE key order so a future cache/dedupe key over the URL
 *   is stable.
 * - Unknown token/route → HTTP 200 with an EMPTY body (not `null`, not `{}`,
 *   no 404). Read the body as text and special-case empty → typed not-found.
 * - Input mistakes → HTTP 500 `text/plain` with a leaked exception → mapped to a
 *   safe `VexError` by `errors.ts`.
 * - `limit` is capped at 30 server-side; the client clamps to match.
 * - No documented rate limit and a ~2s server cache; NO throttle in P1.
 */

import { loadConfig } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { fetchWithTimeout } from "../../utils/http.js";
import { TRENCH_ENDPOINTS, TRENCH_LIMIT_CAP } from "./constants.js";
import { mapTransportError, mapTrenchExpressError } from "./errors.js";
import type {
  TrenchSearchParams,
  TrenchToken,
  TrenchTokenQuery,
  TrenchTokensParams,
  TrenchTradesParams,
  TrenchTrade,
  TrenchWalletStats,
} from "./types.js";
import { validateToken, validateTokenList, validateTrades, validateWalletStats } from "./validation.js";

/** Sentinel returned by `send` when the provider answered 200 with an empty body. */
const EMPTY_BODY = Symbol("trench-empty-body");

/** Recursively serialize with sorted keys so equal params always yield one string. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Clamp a caller-supplied `limit` to the server cap; undefined leaves it to the server. */
function clampLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  return Math.max(1, Math.min(TRENCH_LIMIT_CAP, Math.floor(limit)));
}

export class TrenchExpressClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * Build the request URL: `<base><path>?params=<stable-json>`. One private
   * builder keeps the query encoding — and therefore any future cache key — in
   * a single place with a deterministic key order.
   */
  private buildUrl(path: string, params: Record<string, unknown>): string {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    url.searchParams.set("params", stableStringify(params));
    return url.toString();
  }

  /**
   * Fetch + read-as-text. Returns parsed JSON, or `EMPTY_BODY` when the provider
   * answered 200 with no body (its "not found"). Transport failures and non-ok
   * statuses become typed `TRENCH_*` errors.
   */
  private async send(path: string, params: Record<string, unknown>): Promise<unknown | typeof EMPTY_BODY> {
    const url = this.buildUrl(path, params);
    try {
      const response = await fetchWithTimeout(url);
      const text = await response.text();

      if (!response.ok) {
        throw mapTrenchExpressError(response.status, text);
      }
      if (text.trim().length === 0) {
        return EMPTY_BODY;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new VexError(
          ErrorCodes.TRENCH_INVALID_RESPONSE,
          "Trench Express returned a non-JSON body",
          "The launchpad API returned an unexpected response shape.",
        );
      }
    } catch (err) {
      mapTransportError(err);
    }
  }

  // ── Endpoints ───────────────────────────────────────────────────

  /**
   * List tokens. `status` maps to the API's boolean `launched` filter
   * (`curve`→false, `launched`→true, `all`→omit). Returns `[]` on an empty body.
   */
  async getTokens(params: TrenchTokensParams): Promise<TrenchToken[]> {
    const query: Record<string, unknown> = { page: params.page };
    const limit = clampLimit(params.limit);
    if (limit !== undefined) query.limit = limit;
    if (params.sort !== undefined) query.sort = params.sort;
    if (params.status === "curve") query.launched = false;
    else if (params.status === "launched") query.launched = true;

    const raw = await this.send(TRENCH_ENDPOINTS.tokens, query);
    if (raw === EMPTY_BODY) return [];
    return validateTokenList(raw);
  }

  /**
   * Fetch one token by address OR symbol. Returns `null` for the provider's
   * empty-body "not found".
   */
  async getToken(query: TrenchTokenQuery): Promise<TrenchToken | null> {
    const raw = await this.send(TRENCH_ENDPOINTS.token, query);
    if (raw === EMPTY_BODY) return null;
    return validateToken(raw);
  }

  /** Search tokens by name/symbol. Returns `[]` when nothing matches. */
  async search(params: TrenchSearchParams): Promise<TrenchToken[]> {
    const query: Record<string, unknown> = { search: params.search };
    const limit = clampLimit(params.limit);
    if (limit !== undefined) query.limit = limit;

    const raw = await this.send(TRENCH_ENDPOINTS.search, query);
    if (raw === EMPTY_BODY) return [];
    return validateTokenList(raw);
  }

  /** Per-token trade tape. `page` is REQUIRED by the provider. Returns `[]` on empty body. */
  async getTrades(params: TrenchTradesParams): Promise<TrenchTrade[]> {
    const query: Record<string, unknown> = { token: params.token, page: params.page };
    const limit = clampLimit(params.limit);
    if (limit !== undefined) query.limit = limit;

    const raw = await this.send(TRENCH_ENDPOINTS.trades, query);
    if (raw === EMPTY_BODY) return [];
    return validateTrades(raw);
  }

  /** Per-wallet XP/faction stats. Returns `null` for an empty-body "not found". */
  async getWalletStats(address: string): Promise<TrenchWalletStats | null> {
    const raw = await this.send(TRENCH_ENDPOINTS.stats, { address });
    if (raw === EMPTY_BODY) return null;
    return validateWalletStats(raw);
  }

  /**
   * Walk `/api/tokens` pages until a short page (fewer than `limit` rows) is
   * seen, deduping by lowercased token address. The server caps `limit` at 30
   * and gives no total count, so the short-page terminator is the only reliable
   * stop. `maxPages` bounds the walk defensively.
   */
  async walkTokens(
    params: Omit<TrenchTokensParams, "page">,
    maxPages = 20,
  ): Promise<TrenchToken[]> {
    const limit = clampLimit(params.limit) ?? TRENCH_LIMIT_CAP;
    const seen = new Set<string>();
    const out: TrenchToken[] = [];

    for (let page = 0; page < maxPages; page += 1) {
      const rows = await this.getTokens({ ...params, page, limit });
      for (const row of rows) {
        const key = row.token.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(row);
        }
      }
      if (rows.length < limit) break;
    }
    return out;
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: TrenchExpressClient | null = null;
let cachedBaseUrl: string | null = null;

/** Shared client, rebuilt only when the configured base URL changes. */
export function getTrenchExpressClient(): TrenchExpressClient {
  const baseUrl = loadConfig().services.trenchExpressApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) {
    return cachedClient;
  }
  cachedClient = new TrenchExpressClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
