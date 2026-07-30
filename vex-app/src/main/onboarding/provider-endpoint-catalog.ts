/**
 * OpenRouter ENDPOINT catalogue for one model, projected into renderer-safe
 * metadata for the wizard's provider select.
 *
 * `client.endpoints.list({author, slug})` (installed SDK 1.1.13) resolves to
 * `{ data: { endpoints: PublicEndpoint[] , … } }` — an object property, NOT an
 * array response. Fields are camelCased by the SDK (`tag`,
 * `supportedParameters`, `contextLength`, `quantization`,
 * `pricing.inputCacheRead` / `pricing.inputCacheWrite`).
 *
 * TOOL FILTER (hard, server-side): Vex is a tool-calling agent. An endpoint
 * whose `supportedParameters` lacks `tools` cannot run the product at all, so
 * it is dropped HERE and never crosses IPC — the renderer gets no
 * disable-with-reason row it could re-enable. Note the honest scope: this
 * checks tool support only. Vex also sends `toolChoice` and `maxTokens`, and
 * strict per-parameter compatibility is enforced at request time by
 * `requireParameters` — the filter is not a general compatibility promise.
 *
 * PRICING: the SDK's prices are per-TOKEN decimal strings and reflect BASE
 * conditions only; `pricing.overrides` carries conditional long-context /
 * time-window rates we deliberately do not model. Converted defensively to
 * per-million numbers (a malformed value becomes `null`, never NaN) and
 * labelled as base rates in the UI.
 *
 * AVAILABILITY: the SDK also publishes `uptimeLast5m/30m/1d` and a `status`
 * derank enum. Those are carried through to the renderer and DECIDE THE ORDER
 * of this list (price is now only a tiebreak) — see
 * `provider-endpoint-availability.ts` for the rule and the live 429 evidence
 * behind it. `latencyLast30m`/`throughputLast30m` are NOT carried: the SDK
 * documents them as authenticated-only and this client is keyless by design.
 *
 * CACHING: a small per-model snapshot cache with the same failure-cooldown
 * discipline as `provider-model-catalog.ts`. Bounded by
 * `ENDPOINT_CACHE_MAX_MODELS` so a renderer that walks the whole catalogue
 * cannot grow main-process memory without limit.
 */

import type { OpenRouter, Fetcher } from "@vex-lib/openrouter-client.js";
import {
  PROVIDER_ENDPOINT_LIST_MAX,
  splitOpenRouterModelId,
  type ProviderEndpointOption,
  type ProviderListEndpointsResult,
} from "@shared/schemas/provider-endpoints.js";
import { createPublicOpenRouterClient } from "./openrouter-public-catalog-client.js";
import {
  compareEndpointsByAvailability,
  computeAvailabilityScore,
  suggestedEndpointTagOf,
} from "./provider-endpoint-availability.js";

const ENDPOINT_TTL_MS = 3_600_000;
const ENDPOINT_TIMEOUT_MS = 15_000;
/** Mirrors the model catalogue: after a failure, do not re-hit the network. */
const ENDPOINT_FAILURE_COOLDOWN_MS = 10_000;
/** Bound on distinct models kept in memory (LRU-by-insertion eviction). */
const ENDPOINT_CACHE_MAX_MODELS = 32;

type EndpointsClient = Pick<OpenRouter["endpoints"], "list">;

export interface LoadProviderEndpointCatalogOptions {
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => number) | undefined;
  readonly clientFactory?: (() => { readonly endpoints: EndpointsClient }) | undefined;
  /** Test-only override of the REAL default client's `fetch`. */
  readonly fetcher?: Fetcher | undefined;
}

interface CacheEntry {
  readonly result: ProviderListEndpointsResult;
  readonly cachedAtMs: number;
}

const cache = new Map<string, CacheEntry>();
const cooldownUntilMsByModel = new Map<string, number>();

/** Raw endpoint row as we consume it — provider response is untrusted. */
interface RawEndpointRow {
  readonly tag?: unknown;
  readonly providerName?: unknown;
  readonly contextLength?: unknown;
  readonly quantization?: unknown;
  readonly supportedParameters?: unknown;
  readonly uptimeLast5m?: unknown;
  readonly uptimeLast30m?: unknown;
  readonly uptimeLast1d?: unknown;
  readonly status?: unknown;
  readonly pricing?:
    | {
        readonly prompt?: unknown;
        readonly completion?: unknown;
        readonly inputCacheRead?: unknown;
        readonly inputCacheWrite?: unknown;
        readonly internalReasoning?: unknown;
      }
    | undefined;
}

function parsePricePerMillion(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const perToken = Number(raw);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  const perMillion = perToken * 1_000_000;
  return Number.isFinite(perMillion) ? perMillion : null;
}

/**
 * An uptime window, or `null` when absent/out of range. OpenRouter documents
 * these as percentages and sends `null` for "insufficient data"; anything
 * outside 0–100 is a provider response we do not understand, so it becomes
 * UNKNOWN rather than being clamped into a number the UI would present as fact.
 */
function parseUptimePercent(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 100) return null;
  return raw;
}

/**
 * The raw `status` enum. Kept as the integer OpenRouter sent so a future enum
 * member survives; bounded because it is untrusted input, and non-integers are
 * rejected rather than rounded.
 */
function parseEndpointStatus(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  if (raw < -100 || raw > 100) return null;
  return raw;
}

function boundedString(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * Project one raw endpoint, or `null` when it is unusable: no routable `tag`,
 * no display name, or — the product-critical case — no `tools` support.
 */
export function normalizeEndpoint(row: RawEndpointRow): ProviderEndpointOption | null {
  const supportedParameters: ReadonlyArray<unknown> = Array.isArray(
    row.supportedParameters,
  )
    ? row.supportedParameters
    : [];
  if (!supportedParameters.includes("tools")) return null;

  const tag = boundedString(row.tag, 200);
  const providerName = boundedString(row.providerName, 200);
  if (tag === null || providerName === null) return null;

  const contextLength =
    typeof row.contextLength === "number" &&
    Number.isInteger(row.contextLength) &&
    row.contextLength > 0
      ? row.contextLength
      : null;

  const uptimeWindows = {
    uptimeLast5mPercent: parseUptimePercent(row.uptimeLast5m),
    uptimeLast30mPercent: parseUptimePercent(row.uptimeLast30m),
    uptimeLast1dPercent: parseUptimePercent(row.uptimeLast1d),
  };
  const statusCode = parseEndpointStatus(row.status);

  return {
    tag,
    providerName,
    contextLength,
    quantization: boundedString(row.quantization, 64),
    pricingInputPerMillion: parsePricePerMillion(row.pricing?.prompt),
    pricingOutputPerMillion: parsePricePerMillion(row.pricing?.completion),
    pricingCacheReadPerMillion: parsePricePerMillion(row.pricing?.inputCacheRead),
    pricingCacheWritePerMillion: parsePricePerMillion(row.pricing?.inputCacheWrite),
    pricingReasoningPerMillion: parsePricePerMillion(row.pricing?.internalReasoning),
    ...uptimeWindows,
    statusCode,
    // Absent status is NOT deranked: OpenRouter omits the field rather than
    // sending a negative one, and inventing a derank from silence would demote
    // a healthy endpoint.
    isDeranked: statusCode !== null && statusCode < 0,
    availabilityScore: computeAvailabilityScore(uptimeWindows),
  };
}

function rememberSnapshot(modelId: string, entry: CacheEntry): void {
  cache.delete(modelId);
  cache.set(modelId, entry);
  while (cache.size > ENDPOINT_CACHE_MAX_MODELS) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

async function fetchEndpoints(
  modelId: string,
  options: LoadProviderEndpointCatalogOptions,
): Promise<ProviderListEndpointsResult> {
  const target = splitOpenRouterModelId(modelId);
  // Defence in depth: the IPC schema already rejects a malformed id, but this
  // value is interpolated into a provider URL path.
  if (target === null) throw new Error("Unsupported OpenRouter model id");

  const client = (
    options.clientFactory ??
    (() => createPublicOpenRouterClient({ timeoutMs: ENDPOINT_TIMEOUT_MS, fetcher: options.fetcher }))
  )();
  const response = await client.endpoints.list(
    { author: target.author, slug: target.slug },
    { timeoutMs: ENDPOINT_TIMEOUT_MS, retries: { strategy: "none" } },
  );

  // `response.data.endpoints` — an object property, not an array response.
  const rows: ReadonlyArray<RawEndpointRow> = Array.isArray(
    response.data?.endpoints,
  )
    ? (response.data.endpoints as ReadonlyArray<RawEndpointRow>)
    : [];

  const byTag = new Map<string, ProviderEndpointOption>();
  for (const row of rows) {
    const endpoint = normalizeEndpoint(row);
    if (endpoint !== null && !byTag.has(endpoint.tag)) {
      byTag.set(endpoint.tag, endpoint);
    }
  }

  // Rank BEFORE truncating, so the cap drops the least available endpoints
  // rather than an arbitrary tail of the provider's own ordering.
  const ranked = [...byTag.values()]
    .sort(compareEndpointsByAvailability)
    .slice(0, PROVIDER_ENDPOINT_LIST_MAX);

  return {
    modelId,
    endpoints: ranked,
    suggestedEndpointTag: suggestedEndpointTagOf(ranked),
  };
}

/**
 * Tool-capable endpoints for ONE model. Serves a fresh cache entry within the
 * TTL; after a failure, serves a stale entry (or rethrows when there is none)
 * for the cooldown window instead of re-hitting the network per call.
 */
export async function loadProviderEndpointCatalog(
  modelId: string,
  options: LoadProviderEndpointCatalogOptions = {},
): Promise<ProviderListEndpointsResult> {
  const now = (options.now ?? Date.now)();
  const entry = cache.get(modelId);
  if (entry !== undefined && now - entry.cachedAtMs < ENDPOINT_TTL_MS) {
    return entry.result;
  }
  if (now < (cooldownUntilMsByModel.get(modelId) ?? 0)) {
    if (entry !== undefined) return entry.result;
    throw new Error("OpenRouter endpoint catalogue temporarily unavailable");
  }

  try {
    const result = await fetchEndpoints(modelId, options);
    rememberSnapshot(modelId, { result, cachedAtMs: now });
    cooldownUntilMsByModel.delete(modelId);
    return result;
  } catch (cause: unknown) {
    cooldownUntilMsByModel.set(modelId, now + ENDPOINT_FAILURE_COOLDOWN_MS);
    if (entry !== undefined) return entry.result;
    throw cause;
  }
}

/**
 * Persist-time authorisation check: is `endpointTag` a tool-capable endpoint
 * of `modelId`?
 *
 * The renderer is untrusted, so a pin is only written after the tag is proven
 * to exist in the SAME server-side projection the picker was built from. A
 * catalogue failure here returns `false` — refusing an unverifiable pin is the
 * conservative outcome; the operator can retry or choose Auto.
 */
export async function isKnownToolCapableEndpoint(
  modelId: string,
  endpointTag: string,
  options: LoadProviderEndpointCatalogOptions = {},
): Promise<boolean> {
  try {
    const result = await loadProviderEndpointCatalog(modelId, options);
    return result.endpoints.some((endpoint) => endpoint.tag === endpointTag);
  } catch {
    return false;
  }
}

export function __resetProviderEndpointCatalogForTests(): void {
  cache.clear();
  cooldownUntilMsByModel.clear();
}
