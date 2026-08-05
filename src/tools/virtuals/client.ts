/**
 * Virtuals Protocol REST client (read-only).
 *
 * Wraps the three Virtuals endpoints the agent uses — agent detail, agent list
 * (per chain), and the genesis launch calendar — with tolerant validation and a
 * conservative per-process throttle. The API (https://api.virtuals.io) is an
 * UNAUTHENTICATED, UNDOCUMENTED Strapi backend: no API key is sent, the list
 * endpoint requires a `filters[chain]` param (a bare list 400s), and
 * `filters[status]` is silently ignored server-side (status filtering happens
 * client-side in the protocol handlers). Singleton via getVirtualsClient().
 */

import { loadConfig } from "../../config/store.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import logger from "../../utils/logger.js";
import { mapVirtualsError, mapVirtualsTransportError } from "./errors.js";
import { VirtualsThrottle, parseRetryAfterMs } from "./throttle.js";
import type {
  ListGenesesParams,
  ListVirtualsParams,
  VirtualsAgent,
  VirtualsGenesesResult,
  VirtualsListResult,
} from "./types.js";
import {
  validateGeneses,
  validateVirtualDetail,
  validateVirtualsList,
} from "./validation.js";

/** Descriptive UA so the undocumented backend can attribute our traffic. */
const USER_AGENT = "Vex-Agent/1.0 (+https://vexlabs.ai)";

const DEFAULT_PAGE_SIZE = 20;
/**
 * The provider's proven ceiling, not ours. The old value of 50 was OUR
 * invention: live probe 2026-08-03 sent `pagination[pageSize]=200` and got
 * HTTP 200 with 200 rows and `meta.pagination.pageSize: 200` echoed back. A
 * cap we invented and then described as the API's is how `virtuals.list` came
 * to search 50 rows of a 54,785-row chain (SPEC §2.6 W9a).
 */
const MAX_PAGE_SIZE = 200;

export class VirtualsClient {
  private readonly throttle: VirtualsThrottle;

  constructor(private readonly baseUrl: string) {
    // Per-process throttle + cache shared by every consumer of this client.
    this.throttle = new VirtualsThrottle();
  }

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
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const ttlMs = this.throttle.defaultTtlMs;
    // The normalized request URL (path + ordered query) is the cache/dedupe key.
    try {
      return await this.throttle.run(url, ttlMs, async () => {
        const response = await fetchWithTimeout(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        });

        if (!response.ok) {
          if (response.status === 429) {
            // Optional chaining guards test doubles that omit `headers`.
            const retryMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
            this.throttle.penalize(retryMs);
          }
          // The upstream body is untrusted, so it is SANITIZED — not hidden.
          // Hiding it (the module's previous, documented policy) made a 403
          // edge challenge and a 400 missing-filter indistinguishable at the
          // agent; `mapVirtualsError` redacts and caps it instead.
          const raw = await readJson(response);
          logger.warn("virtuals.api.http_error", {
            status: response.status,
            path,
            detail: raw === null ? null : JSON.stringify(raw).slice(0, 200),
          });
          throw mapVirtualsError(response.status, raw);
        }

        const raw = await readJson(response);
        return validator(raw);
      });
    } catch (err) {
      mapVirtualsTransportError(err);
    }
  }

  /** Get one Virtuals agent by numeric id (rich detail payload). */
  getVirtual(id: number | string): Promise<VirtualsAgent | null> {
    return this.request(
      `/api/virtuals/${encodeURIComponent(String(id))}`,
      validateVirtualDetail,
    );
  }

  /**
   * List agents on ONE chain. `filters[chain]` is REQUIRED by the API. Sort is
   * always descending on the requested field (default mcapInVirtual). Status is
   * NOT filtered here (the server ignores it) — the caller filters client-side.
   */
  listVirtuals(params: ListVirtualsParams): Promise<VirtualsListResult> {
    const sortField = params.sort ?? "mcapInVirtual";
    const page = clampPositiveInt(params.page, 1);
    const pageSize = Math.min(clampPositiveInt(params.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const query: Record<string, string | undefined> = {
      "filters[chain]": params.chain,
      "sort[0]": `${sortField}:desc`,
      "pagination[page]": String(page),
      "pagination[pageSize]": String(pageSize),
    };
    if (params.isVerified !== undefined) {
      query["filters[isVerified]"] = String(params.isVerified);
    }
    return this.request("/api/virtuals", validateVirtualsList, query);
  }

  /** List genesis launches (Base launch calendar; newest first by id). */
  listGeneses(params: ListGenesesParams = {}): Promise<VirtualsGenesesResult> {
    const page = clampPositiveInt(params.page, 1);
    const pageSize = Math.min(clampPositiveInt(params.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    return this.request("/api/geneses", validateGeneses, {
      "sort[0]": "id:desc",
      "pagination[page]": String(page),
      "pagination[pageSize]": String(pageSize),
    });
  }
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value !== undefined && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return fallback;
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: VirtualsClient | null = null;
let cachedBaseUrl: string | null = null;

export function getVirtualsClient(): VirtualsClient {
  const baseUrl = loadConfig().services.virtualsApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) {
    return cachedClient;
  }

  cachedClient = new VirtualsClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
