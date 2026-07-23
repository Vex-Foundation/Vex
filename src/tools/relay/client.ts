/**
 * Relay (api.relay.link) HTTP client — KEYLESS cross-chain bridge.
 *
 * GET /chains (cached, TTL 1h), POST /quote/v2, GET /intents/status/v3. No API
 * key anywhere (Relay's public rate limit — 50 quotes/min/IP — fits a per-user
 * desktop). Every response is Zod-validated at this boundary (see ./types.ts).
 *
 * QUOTE MIGRATION (Wave-2 W2): quotes go to `POST /quote/v2` — v1 `POST /quote`
 * is deprecated. v2 adds a top-level `requestId` and per-side USD under
 * `details{}`; the step/status shapes are unchanged, so this is endpoint-path +
 * response-schema only (no signature change).
 */

import { loadConfig } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import {
  RelayChainsResponseSchema,
  RelayQuoteResponseSchema,
  RelayStatusResponseSchema,
  type RelayChain,
  type RelayQuoteRequest,
  type RelayQuoteResponse,
  type RelayStatusResponse,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const CHAINS_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Canonical Relay intent-status path. Single source of truth: used both to build
 * the status request AND to validate a quote's step `check.endpoint` before we
 * trust the requestId it carries (see relay/execute
 * `parseRequestIdFromCheckEndpoint` and the correlation contract in
 * relay/correlation.ts).
 */
export const RELAY_INTENT_STATUS_PATH = "/intents/status/v3";

function mapTransportError(err: unknown): never {
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw new VexError(ErrorCodes.RELAY_TIMEOUT, err.message, err.hint);
  }
  if (err instanceof VexError && err.code.startsWith("RELAY_")) throw err;
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw new VexError(ErrorCodes.RELAY_API_ERROR, err.message, err.hint);
  }
  throw err;
}

export class RelayClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v.length > 0) url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    validate: (raw: unknown) => T,
    options: { method?: "GET" | "POST"; query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<T> {
    try {
      const response = await fetchWithTimeout(this.url(path, options.query), {
        method: options.method ?? "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (!response.ok) {
        throw new VexError(
          response.status === 429 ? ErrorCodes.RELAY_RATE_LIMITED : ErrorCodes.RELAY_API_ERROR,
          `Relay request failed (${response.status})`,
          response.status === 429 ? "Relay rate limit — retry shortly." : undefined,
        );
      }
      return validate(await readJson(response));
    } catch (err) {
      mapTransportError(err);
    }
  }

  async getChains(): Promise<RelayChain[]> {
    const parsed = await this.request("/chains", (raw) => RelayChainsResponseSchema.parse(raw));
    return parsed.chains;
  }

  getQuote(request: RelayQuoteRequest): Promise<RelayQuoteResponse> {
    return this.request("/quote/v2", (raw) => RelayQuoteResponseSchema.parse(raw), {
      method: "POST",
      body: request,
    });
  }

  getIntentStatus(requestId: string): Promise<RelayStatusResponse> {
    return this.request(RELAY_INTENT_STATUS_PATH, (raw) => RelayStatusResponseSchema.parse(raw), {
      query: { requestId },
    });
  }
}

// ── Singleton (rebuilt when the configured base URL changes) ──────────────────

let cachedClient: RelayClient | null = null;
let cachedBaseUrl: string | null = null;

export function getRelayClient(): RelayClient {
  const baseUrl = loadConfig().services.relayApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) return cachedClient;
  cachedClient = new RelayClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}

// ── Chains cache (TTL 1h) ─────────────────────────────────────────────────────

let cachedChains: RelayChain[] | null = null;
let chainsCachedAt = 0;

/** Cached Relay chain registry (TTL 1h). Refreshes on expiry. */
export async function getCachedRelayChains(): Promise<RelayChain[]> {
  if (cachedChains && Date.now() - chainsCachedAt < CHAINS_TTL_MS) return cachedChains;
  const chains = await getRelayClient().getChains();
  cachedChains = chains;
  chainsCachedAt = Date.now();
  return chains;
}

/** Test/utility hook — clear the chains cache. */
export function clearRelayChainsCache(): void {
  cachedChains = null;
  chainsCachedAt = 0;
}
