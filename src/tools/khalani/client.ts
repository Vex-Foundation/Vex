import { loadConfig } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import { assertAutocompleteLimit, assertOrdersQueryBounds } from "./bounds.js";
import type {
  AutocompleteResponse,
  DepositBuildRequest,
  DepositPlan,
  KhalaniChain,
  KhalaniErrorBody,
  KhalaniOrder,
  KhalaniToken,
  OrdersResponse,
  QuoteRequest,
  QuoteStreamRoute,
  QuoteResponse,
  SubmitRequest,
  SubmitResponse,
  TokenSearchResponse,
} from "./types.js";
import { mapKhalaniError } from "./errors.js";
import {
  parseKhalaniErrorPayload,
  validateAutocompleteResponse,
  validateChainsResponse,
  validateDepositPlan,
  validateOrderResponse,
  validateOrdersResponse,
  validateQuoteResponse,
  validateQuoteStreamRoute,
  validateSubmitResponse,
  validateTokenSearchResponse,
  validateTokensResponse,
} from "./validation.js";

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  query?: Record<string, string | undefined>;
  body?: unknown;
}

/**
 * The header set EVERY Khalani request sends (W2d).
 *
 * The API is Cloudflare-fronted, and until this landed we sent NO `User-Agent`
 * and NO `Accept` — running on the accident that Node's `fetch` supplies
 * `user-agent: node`, which the edge happens to accept. KyberSwap proved what
 * the other side of that accident looks like: an identical header shape got
 * HTTP 403 with `cf-mitigated: challenge` and an HTML body where JSON was
 * expected (SPEC §2.1, W2a). Making both headers explicit removes the runtime
 * dependency; it also stops this client from being the counter-example to the
 * fleet-wide client rule.
 *
 * Same literal as `KYBERSWAP_REQUEST_HEADERS` — deliberately copied rather than
 * imported, because a venue adapter must not depend on another venue's module.
 */
const KHALANI_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "Vex/1.0.0 (+https://projectvex.ai)",
  Accept: "application/json",
};

/**
 * Read a non-ok response's payload as TEXT, then decide what it is.
 *
 * Khalani does not always answer JSON on an error: live 2026-08-03, `GET
 * /v1/nope` returns `content-type: text/plain` with the body `404 Not Found`.
 * `readJson` swallows the parse failure and returns `null`, which erased the
 * provider's own words. Reading text ONCE (the body may only be consumed once)
 * and parsing it ourselves keeps both spellings.
 */
async function readKhalaniErrorBody(response: Response): Promise<KhalaniErrorBody | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  return parseKhalaniErrorPayload(text);
}

function mapTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("KHALANI_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw new VexError(ErrorCodes.KHALANI_TIMEOUT, err.message, err.hint);
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, err.message, err.hint);
  }
  throw err;
}

export class KhalaniClient {
  constructor(private readonly baseUrl: string) {}

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value.length > 0) {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    validator: (raw: unknown) => T,
    options: RequestOptions = {},
  ): Promise<T> {
    try {
      const response = await fetchWithTimeout(this.buildUrl(path, options.query), {
        method: options.method ?? "GET",
        headers: options.body === undefined
          ? KHALANI_REQUEST_HEADERS
          : { ...KHALANI_REQUEST_HEADERS, "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (!response.ok) {
        throw mapKhalaniError(response.status, await readKhalaniErrorBody(response));
      }

      const raw = await readJson(response);
      return validator(raw);
    } catch (err) {
      mapTransportError(err);
    }
  }

  getChains(): Promise<KhalaniChain[]> {
    return this.request("/v1/chains", validateChainsResponse);
  }

  getTopTokens(chainIds?: number[]): Promise<KhalaniToken[]> {
    return this.request(
      "/v1/tokens",
      validateTokensResponse,
      { query: { chainIds: chainIds?.join(",") } },
    );
  }

  searchTokens(query: string, chainIds?: number[]): Promise<TokenSearchResponse> {
    return this.request(
      "/v1/tokens/search",
      validateTokenSearchResponse,
      {
        query: {
          q: query,
          chainIds: chainIds?.join(","),
        },
      },
    );
  }

  // `async` so a bound violation REJECTS the returned promise instead of
  // throwing synchronously out of a method whose signature promises a promise.
  async autocompleteToken(keyword: string, opts?: { chainIds?: number[]; limit?: number }): Promise<AutocompleteResponse> {
    assertAutocompleteLimit(opts?.limit);
    return this.request(
      `/v1/tokens/autocomplete/${encodeURIComponent(keyword)}`,
      validateAutocompleteResponse,
      {
        query: {
          chainIds: opts?.chainIds?.join(","),
          limit: opts?.limit != null ? String(opts.limit) : undefined,
        },
      },
    );
  }

  getTokenBalances(address: string, chainIds?: number[]): Promise<KhalaniToken[]> {
    return this.request(
      `/v1/tokens/balances/${encodeURIComponent(address)}`,
      validateTokensResponse,
      { query: { chainIds: chainIds?.join(",") } },
    );
  }

  getQuotes(request: QuoteRequest, opts?: { routes?: string[] }): Promise<QuoteResponse> {
    return this.request(
      "/v1/quotes",
      validateQuoteResponse,
      {
        method: "POST",
        query: { routes: opts?.routes?.join(",") },
        body: request,
      },
    );
  }

  async *streamQuotes(request: QuoteRequest, opts?: { routes?: string[] }): AsyncGenerator<QuoteStreamRoute> {
    try {
      const response = await fetchWithTimeout(
        this.buildUrl("/v1/quotes", {
          mode: "stream",
          routes: opts?.routes?.join(","),
        }),
        {
          method: "POST",
          headers: {
            ...KHALANI_REQUEST_HEADERS,
            "Content-Type": "application/json",
            // Overrides the shared `Accept`: this endpoint streams NDJSON.
            Accept: "application/x-ndjson",
          },
          body: JSON.stringify(request),
        },
      );

      if (!response.ok) {
        throw mapKhalaniError(response.status, await readKhalaniErrorBody(response));
      }

      if (!response.body) {
        throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Khalani stream response did not include a body.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              throw new VexError(ErrorCodes.KHALANI_API_ERROR, `Invalid Khalani NDJSON line: ${line}`);
            }
            yield validateQuoteStreamRoute(parsed);
          }
          newlineIndex = buffer.indexOf("\n");
        }

        if (done) {
          const trailing = buffer.trim();
          if (trailing.length > 0) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(trailing);
            } catch {
              throw new VexError(ErrorCodes.KHALANI_API_ERROR, `Invalid Khalani NDJSON line: ${trailing}`);
            }
            yield validateQuoteStreamRoute(parsed);
          }
          break;
        }
      }
    } catch (err) {
      mapTransportError(err);
    }
  }

  buildDeposit(request: DepositBuildRequest): Promise<DepositPlan> {
    return this.request(
      "/v1/deposit/build",
      validateDepositPlan,
      {
        method: "POST",
        body: request,
      },
    );
  }

  submitDeposit(request: SubmitRequest): Promise<SubmitResponse> {
    return this.request(
      "/v1/deposit/submit",
      validateSubmitResponse,
      {
        method: "PUT",
        body: request,
      },
    );
  }

  // `async` for the same reason as `autocompleteToken` — see its note.
  async getOrders(
    address: string,
    opts?: {
      limit?: number;
      cursor?: number;
      fromChainId?: number;
      toChainId?: number;
      orderIds?: string;
      txHashSearch?: string;
    },
  ): Promise<OrdersResponse> {
    assertOrdersQueryBounds({ limit: opts?.limit, txHashSearch: opts?.txHashSearch });
    return this.request(
      `/v1/orders/${encodeURIComponent(address)}`,
      validateOrdersResponse,
      {
        query: {
          limit: opts?.limit != null ? String(opts.limit) : undefined,
          cursor: opts?.cursor != null ? String(opts.cursor) : undefined,
          fromChainId: opts?.fromChainId != null ? String(opts.fromChainId) : undefined,
          toChainId: opts?.toChainId != null ? String(opts.toChainId) : undefined,
          orderIds: opts?.orderIds,
          txHashSearch: opts?.txHashSearch,
        },
      },
    );
  }

  getOrderById(orderId: string): Promise<KhalaniOrder> {
    return this.request(`/v1/orders/by-id/${encodeURIComponent(orderId)}`, validateOrderResponse);
  }

  getChainIconUrl(chainId: number): string {
    return this.buildUrl(`/v1/chain/${chainId}/icon`);
  }
}

let cachedClient: KhalaniClient | null = null;
let cachedBaseUrl: string | null = null;

export function getKhalaniClient(): KhalaniClient {
  const baseUrl = loadConfig().services.khalaniApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) {
    return cachedClient;
  }

  cachedClient = new KhalaniClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
