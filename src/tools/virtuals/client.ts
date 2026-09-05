/**
 * Virtuals Protocol REST client (read-only).
 *
 * Wraps the Virtuals endpoints the agent uses - agent detail, agent list, the
 * genesis calendar and the genesis parameters - with tolerant validation and a
 * conservative per-process throttle. The API (https://api.virtuals.io) is an
 * UNAUTHENTICATED, UNDOCUMENTED Strapi backend: no API key is sent, and every
 * filter, operator, sort key and bound this module emits was MEASURED against
 * the live endpoint (provenance table in `Virtuals.md`).
 *
 * THE TWO PROVIDER BEHAVIOURS THIS MODULE EXISTS TO CONTAIN:
 *
 * 1. AN UNKNOWN FILTER KEY IS SILENTLY IGNORED. `filters[bogusKeyXyz]=1`
 *    returned the FULL unfiltered population (56,915 rows on BASE), HTTP 200,
 *    no warning. A typo therefore reads as "no filter", not as an error.
 * 2. AN UNKNOWN VALUE INSIDE A KNOWN KEY RETURNS ZERO ROWS. `filters[factory]`,
 *    `filters[role]`, `filters[category]` and `filters[vibesInfo][status]` all
 *    answered HTTP 200 with `total: 0` for a made-up value - indistinguishable
 *    from a real empty market.
 *
 * Between them, nothing about a wrong request is observable in the response. So
 * this client emits ONLY the closed vocabularies in `./types.ts`; the protocol
 * layer refuses anything outside them BY NAME before a request is built.
 *
 * A third behaviour shapes the sort surface: the provider validates the sort
 * ATTRIBUTE (`sort[0]=totalSupply:desc` -> 400 "Attribute totalSupply not found
 * on model api::virtual.virtual") and REQUIRES a direction (`sort[0]=holderCount`
 * -> 400), but accepts a NONSENSE direction and silently treats it as `desc`.
 * Hence `sortDirection` is a closed enum here rather than a pass-through.
 *
 * Singleton via `getVirtualsClient()`.
 */

import { loadConfig } from "../../config/store.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import logger from "../../utils/logger.js";
import { mapVirtualsError, mapVirtualsTransportError } from "./errors.js";
import { VirtualsThrottle, parseRetryAfterMs } from "./throttle.js";
import {
  VIRTUALS_STATUS_CODES,
  type GetVirtualParams,
  type ListGenesesParams,
  type ListVirtualsParams,
  type VirtualsAgent,
  type VirtualsFilters,
  type VirtualsGenesesResult,
  type VirtualsGenesisParameters,
  type VirtualsListResult,
  type VirtualsRange,
} from "./types.js";
import {
  validateGeneses,
  validateGenesisParameters,
  validateVirtualDetail,
  validateVirtualsList,
} from "./validation.js";

/** Descriptive UA so the undocumented backend can attribute our traffic. */
const USER_AGENT = "Vex-Agent/1.0 (+https://vexlabs.ai)";

const DEFAULT_PAGE_SIZE = 20;

/**
 * OUR ceiling, not the provider's. Measured 2026-09-04, the provider served
 * `pagination[pageSize]=10000` with HTTP 200 and 10,000 rows in one response.
 * We do not, because an agent row carries 84 fields including three multi-KB
 * free-text blobs (`description`, `overview`, `roadmap`): a 10,000-row page is
 * tens of megabytes of untrusted JSON to parse and hold. 200 is the widest page
 * this client will ask for; the model-facing tools cap themselves lower again
 * (see `protocols/virtuals/list-params.ts`), and every row past the cap is
 * reachable with `page`.
 */
const MAX_PAGE_SIZE = 200;

/** Query pairs in the order they were added; the joined string is the cache key. */
type QueryPairs = [string, string][];

function pushRange(out: QueryPairs, field: string, range: VirtualsRange | undefined): void {
  if (!range) return;
  if (range.min !== undefined) out.push([`filters[${field}][$gte]`, String(range.min)]);
  if (range.max !== undefined) out.push([`filters[${field}][$lte]`, String(range.max)]);
}

function pushNotNull(out: QueryPairs, field: string, on: boolean | undefined): void {
  if (on === true) out.push([`filters[${field}][$notNull]`, "true"]);
}

function pushLaunchInfoFlag(out: QueryPairs, field: string, on: boolean | undefined): void {
  if (on === true) out.push([`filters[launchInfo][${field}][$eq]`, "true"]);
}

/**
 * Serialise the closed filter surface. Every expression here was sent live at
 * least once; `Virtuals.md` maps each line to its capture name.
 */
function buildFilterPairs(filters: VirtualsFilters | undefined): QueryPairs {
  const out: QueryPairs = [];
  if (!filters) return out;

  // Status is the BARE numeric form or nothing at all - operators are ignored.
  if (filters.status !== undefined) {
    out.push(["filters[status]", String(VIRTUALS_STATUS_CODES[filters.status])]);
  }

  // Search. `$or` index order is ours and stable, so the cache key is stable.
  if (filters.query !== undefined && filters.query.length > 0) {
    const scope = filters.searchScope ?? "any";
    const clauses: [string, string][] = [];
    if (scope === "text" || scope === "any") {
      clauses.push(["name][$containsi", filters.query], ["symbol][$containsi", filters.query]);
    }
    if (scope === "address" || scope === "any") {
      clauses.push(["tokenAddress][$eqi", filters.query], ["preToken][$eqi", filters.query]);
    }
    clauses.forEach(([suffix, value], index) => {
      out.push([`filters[$or][${index}][${suffix}]`, value]);
    });
  }

  if (filters.symbol !== undefined) out.push(["filters[symbol][$eqi]", filters.symbol]);
  if (filters.tokenAddress !== undefined) {
    // One address can be either the curve token or the graduated token, and the
    // provider stores them in two columns, so an address lookup is always an
    // `$or`. Case-insensitive because rows keep EIP-55 checksummed spelling.
    out.push(
      ["filters[$or][0][tokenAddress][$eqi]", filters.tokenAddress],
      ["filters[$or][1][preToken][$eqi]", filters.tokenAddress],
    );
  }
  if (filters.creatorWallet !== undefined) {
    out.push(["filters[walletAddress][$eqi]", filters.creatorWallet]);
  }

  if (filters.factory !== undefined) out.push(["filters[factory]", filters.factory]);
  if (filters.role !== undefined) out.push(["filters[role]", filters.role]);

  if (filters.isVerified !== undefined) {
    out.push(["filters[isVerified]", String(filters.isVerified)]);
  }
  if (filters.isDevCommitted !== undefined) {
    out.push(["filters[isDevCommitted]", String(filters.isDevCommitted)]);
  }
  if (filters.hasMarginTrading !== undefined) {
    out.push(["filters[hasMarginTrading]", String(filters.hasMarginTrading)]);
  }
  if (filters.hasFounderVideo !== undefined) {
    out.push(["filters[hasFounderVideo]", String(filters.hasFounderVideo)]);
  }
  pushNotNull(out, "revenueConnectWallet", filters.hasRevenueConnect);
  pushNotNull(out, "lpCreatedAt", filters.hasGraduated);
  if (filters.hasGenesis === true) {
    out.push(["filters[genesis][id][$notNull]", "true"]);
  }
  if (filters.hasStaking === true) {
    // The app's own shape: either column proves the agent has staking.
    out.push(
      ["filters[$or][0][stakingAddress][$notNull]", "true"],
      ["filters[$or][1][agentStakingContract][$notNull]", "true"],
    );
  }

  if (filters.genesisStartsAfter !== undefined) {
    out.push(["filters[genesis][startsAt][$gte]", filters.genesisStartsAfter]);
  }
  if (filters.genesisStartsBefore !== undefined) {
    out.push(["filters[genesis][startsAt][$lte]", filters.genesisStartsBefore]);
  }
  if (filters.createdAfter !== undefined) {
    out.push(["filters[createdAt][$gte]", filters.createdAfter]);
  }
  if (filters.launchedAfter !== undefined) {
    out.push(["filters[launchedAt][$gte]", filters.launchedAfter]);
  }

  pushRange(out, "mcapInVirtual", filters.mcapInVirtual);
  pushRange(out, "holderCount", filters.holderCount);
  pushRange(out, "volume24h", filters.volume24h);
  pushRange(out, "priceChangePercent24h", filters.priceChangePercent24h);
  pushRange(out, "top10HolderPercentage", filters.top10HolderPercentage);
  pushRange(out, "liquidityUsd", filters.liquidityUsd);

  if (filters.hasAntiSniperTax === true) {
    out.push(
      ["filters[launchInfo][antiSniperTaxType][$ne]", "0"],
      ["filters[launchInfo][antiSniperTaxType][$notNull]", "true"],
    );
  }
  if (filters.hasAirdrop === true) {
    out.push(["filters[launchInfo][airdropPercent][$gt]", "0"]);
  }
  pushLaunchInfoFlag(out, "needAcf", filters.needAcf);
  pushLaunchInfoFlag(out, "isProject60days", filters.isProject60days);
  pushLaunchInfoFlag(out, "launchRadarEnabled", filters.launchRadarEnabled);
  pushLaunchInfoFlag(out, "isRobotics", filters.isRobotics);

  if (filters.vibesStatus !== undefined) {
    out.push(["filters[vibesInfo][status]", filters.vibesStatus]);
  }

  if (filters.includeLaunchX === true) {
    out.push(
      ["filters[category][$in][0]", "X_LAUNCH"],
      ["filters[category][$in][1]", "ACP_LAUNCH"],
    );
  } else if (filters.excludeLaunchX === true) {
    out.push(
      ["filters[category][$notIn][0]", "X_LAUNCH"],
      ["filters[category][$notIn][1]", "ACP_LAUNCH"],
    );
  }

  return out;
}

export class VirtualsClient {
  private readonly throttle: VirtualsThrottle;

  constructor(private readonly baseUrl: string) {
    // Per-process throttle + cache shared by every consumer of this client.
    this.throttle = new VirtualsThrottle();
  }

  private buildUrl(path: string, pairs: QueryPairs = []): string {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    for (const [key, value] of pairs) {
      if (value.length > 0) url.searchParams.append(key, value);
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    validator: (raw: unknown) => T,
    pairs: QueryPairs = [],
  ): Promise<T> {
    const url = this.buildUrl(path, pairs);
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
          // The upstream body is untrusted, so it is SANITIZED, not hidden.
          // `mapVirtualsError` redacts and caps it; the provider's own
          // sentence is often the only thing that distinguishes a fixable
          // request from an unfixable one (a 400 naming a bad sort attribute
          // versus a 403 edge challenge).
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
  getVirtual(params: GetVirtualParams | number | string): Promise<VirtualsAgent | null> {
    const normalized: GetVirtualParams =
      typeof params === "object" ? params : { id: params };
    const pairs: QueryPairs = [
      // The app's own populate list for the detail page. Without it the
      // relations (`launchInfo`, `genesis`, `vibesInfo`, `image`, `creator`,
      // `tokenomics`) come back absent rather than null, which reads as
      // "the agent has none" instead of "we did not ask".
      ["populate[0]", "image"],
      ["populate[1]", "launchInfo"],
      ["populate[2]", "creator"],
      ["populate[3]", "genesis"],
      ["populate[4]", "vibesInfo"],
      ["populate[5]", "tokenomics.project"],
    ];
    // MEASURED: the detail endpoint IGNORES both flags (the row came back with
    // neither field), so they are forwarded for symmetry only and the detail
    // projection must never promise a price series. `Virtuals.md` records it.
    if (normalized.sparkline) pairs.push(["sparkline", "true"]);
    if (normalized.range24h) pairs.push(["range24h", "true"]);
    return this.request(
      `/api/virtuals/${encodeURIComponent(String(normalized.id))}`,
      validateVirtualDetail,
      pairs,
    );
  }

  /**
   * List agents on ONE chain with the full server-side filter surface.
   * `filters[chain]` is REQUIRED by the API: a bare list returns the
   * cross-chain population (82,834 rows), which is a different question.
   */
  listVirtuals(params: ListVirtualsParams): Promise<VirtualsListResult> {
    const sortField = params.sort ?? "mcapInVirtual";
    const direction = params.sortDirection ?? "desc";
    const page = clampPositiveInt(params.page, 1);
    const pageSize = Math.min(clampPositiveInt(params.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const pairs: QueryPairs = [
      ["filters[chain]", params.chain],
      ...buildFilterPairs(params.filters),
      ["sort[0]", `${sortField}:${direction}`],
      ["pagination[page]", String(page)],
      ["pagination[pageSize]", String(pageSize)],
      ["populate[0]", "image"],
      ["populate[1]", "launchInfo"],
      ["populate[2]", "genesis"],
      ["populate[3]", "vibesInfo"],
    ];
    if (params.skipStats) pairs.push(["skipStats", "true"]);
    if (params.sparkline) pairs.push(["sparkline", "true"]);
    if (params.range24h) pairs.push(["range24h", "true"]);
    return this.request("/api/virtuals", validateVirtualsList, pairs);
  }

  /** List genesis launches (the launch calendar; newest first by id). */
  listGeneses(params: ListGenesesParams = {}): Promise<VirtualsGenesesResult> {
    const page = clampPositiveInt(params.page, 1);
    const pageSize = Math.min(clampPositiveInt(params.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const pairs: QueryPairs = [];
    // MEASURED: this endpoint takes the BARE string form of `status`
    // (`FINALIZED` -> 145, `CANCELLED` -> 33), unlike `/api/virtuals`, whose
    // `status` is numeric. Two endpoints, two spellings, one API.
    if (params.status !== undefined) pairs.push(["filters[status]", params.status]);
    if (params.chain !== undefined) pairs.push(["filters[virtual][chain]", params.chain]);
    if (params.startsAfter !== undefined) {
      pairs.push(["filters[startsAt][$gte]", params.startsAfter]);
    }
    if (params.startsBefore !== undefined) {
      pairs.push(["filters[startsAt][$lte]", params.startsBefore]);
    }
    pairs.push(
      // MEASURED: unlike `/api/virtuals`, this endpoint does NOT validate the
      // sort attribute (`sort[0]=zzz:desc` returned 200 and the default order),
      // so an unchecked sort key would be a silent no-op. The closed
      // `VIRTUALS_GENESIS_SORT_FIELDS` set is the only guard there is.
      ["sort[0]", `${params.sort ?? "id"}:${params.sortDirection ?? "desc"}`],
      ["pagination[page]", String(page)],
      ["pagination[pageSize]", String(pageSize)],
    );
    return this.request("/api/geneses", validateGeneses, pairs);
  }

  /** `GET /api/geneses/parameters` - the reserve tiers a genesis can target. */
  getGenesisParameters(): Promise<VirtualsGenesisParameters> {
    return this.request("/api/geneses/parameters", validateGenesisParameters);
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
