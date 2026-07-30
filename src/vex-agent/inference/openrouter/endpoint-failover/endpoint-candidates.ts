/**
 * Candidate endpoints for the configured model, ranked by UPTIME.
 *
 * WHERE THE LIST COMES FROM. `vex-app/src/main/onboarding/
 * provider-endpoint-catalog.ts` also reads this route, but it lives in the
 * Electron MAIN process and importing it here would (correctly) fail
 * `pnpm --dir vex-app check:boundaries`. The runtime therefore owns its own
 * read, exactly as it already owns the `/models` read
 * (`openrouter/model-catalog.ts`): same SDK, same client, one more route. That
 * is strictly better than injecting a wizard snapshot through config —
 * `uptime` is the ranking key and a snapshot taken at onboarding time would be
 * arbitrarily stale by the time an endpoint actually falls over, which is the
 * only moment this list is consulted.
 *
 * The two readers are NOT duplicated domain logic: the app's projection exists
 * to feed a renderer picker (pricing display, IPC-safe rows) and deliberately
 * DISCARDS uptime; this one exists to rank a failover target and carries
 * uptime plus the per-endpoint price/window needed to re-resolve cost and
 * context after a switch (owner decision 7).
 *
 * TOOL FILTER, same hard rule as the app's: Vex is a tool-calling agent, so an
 * endpoint without `tools` in `supportedParameters` cannot run the product and
 * is not a candidate at any uptime.
 *
 * Untrusted input: every field is validated here (`rules/03`), never trusted as
 * typed — a malformed row is dropped, and a failed fetch yields an EMPTY list
 * rather than throwing, because this runs on the failure path of a turn that is
 * already going badly.
 */

import type { OpenRouter } from "@openrouter/sdk";

import logger from "@utils/logger.js";
import type { EndpointCandidate } from "../../types.js";

export type { EndpointCandidate };

/** Snapshot TTL. Short by catalog standards — uptime is the ranking key. */
const CANDIDATE_TTL_MS = 900_000;
/** After a failed read, do not re-hit the network for this long. */
const CANDIDATE_FAILURE_COOLDOWN_MS = 30_000;
/** Bound on distinct models cached (insertion-order eviction). */
const CANDIDATE_CACHE_MAX_MODELS = 8;
const CANDIDATE_TIMEOUT_MS = 10_000;

/** Raw row shape as we consume it — provider response is untrusted. */
interface RawEndpointRow {
  readonly tag?: unknown;
  readonly providerName?: unknown;
  readonly contextLength?: unknown;
  readonly supportedParameters?: unknown;
  readonly uptimeLast1d?: unknown;
  readonly uptimeLast30m?: unknown;
  readonly uptimeLast5m?: unknown;
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

function boundedString(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/** Per-TOKEN decimal string → per-1M number; anything unusable becomes `null`. */
function parsePricePerMillion(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const perToken = Number(raw);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  const perMillion = perToken * 1_000_000;
  return Number.isFinite(perMillion) ? perMillion : null;
}

/** Uptime is a percentage; anything outside 0..100 is a malformed reading. */
function parseUptimePercent(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 100) return null;
  return raw;
}

function parseContextLength(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Project one raw endpoint row, or `null` when it is unusable: no routable
 * `tag`, no display name, or no `tools` support.
 */
export function normalizeEndpointCandidate(row: RawEndpointRow): EndpointCandidate | null {
  const supportedParameters: ReadonlyArray<unknown> = Array.isArray(row.supportedParameters)
    ? row.supportedParameters
    : [];
  if (!supportedParameters.includes("tools")) return null;

  const tag = boundedString(row.tag, 200);
  const providerName = boundedString(row.providerName, 200);
  if (tag === null || providerName === null) return null;

  return {
    tag,
    providerName,
    uptimePercent:
      parseUptimePercent(row.uptimeLast1d)
      ?? parseUptimePercent(row.uptimeLast30m)
      ?? parseUptimePercent(row.uptimeLast5m),
    contextLength: parseContextLength(row.contextLength),
    inputPricePerM: parsePricePerMillion(row.pricing?.prompt),
    outputPricePerM: parsePricePerMillion(row.pricing?.completion),
    cachePricePerM: parsePricePerMillion(row.pricing?.inputCacheRead),
    cacheWritePricePerM: parsePricePerMillion(row.pricing?.inputCacheWrite),
    reasoningPricePerM: parsePricePerMillion(row.pricing?.internalReasoning),
  };
}

/**
 * Highest uptime first (owner decision 1). Unknown uptime sorts last; ties
 * broken by `tag` so selection is deterministic and a test can assert it.
 */
export function rankByUptime(
  candidates: ReadonlyArray<EndpointCandidate>,
): EndpointCandidate[] {
  return [...candidates].sort((a, b) => {
    const uptimeOrder =
      (b.uptimePercent ?? Number.NEGATIVE_INFINITY)
      - (a.uptimePercent ?? Number.NEGATIVE_INFINITY);
    if (uptimeOrder !== 0) return uptimeOrder;
    return a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" });
  });
}

/**
 * Split `author/slug` out of an OpenRouter model id. The value is interpolated
 * into a provider URL path, so a malformed id is rejected rather than sent
 * (`rules/03` unsafe sinks). A `:variant` suffix (`…:free`, `…:nitro`) is not
 * part of the endpoints route's slug.
 */
export function splitModelId(
  modelId: string,
): { readonly author: string; readonly slug: string } | null {
  const parts = modelId.split("/");
  if (parts.length !== 2) return null;
  const author = parts[0]?.trim() ?? "";
  const slug = (parts[1]?.split(":")[0] ?? "").trim();
  if (!/^[\w.-]+$/.test(author) || !/^[\w.-]+$/.test(slug)) return null;
  return { author, slug };
}

interface CacheEntry {
  readonly candidates: ReadonlyArray<EndpointCandidate>;
  readonly cachedAtMs: number;
}

const cache = new Map<string, CacheEntry>();
const cooldownUntilMsByModel = new Map<string, number>();

/** Test seam — the failover state is process-global, so tests must reset it. */
export function resetEndpointCandidateCache(): void {
  cache.clear();
  cooldownUntilMsByModel.clear();
}

type EndpointsClient = Pick<OpenRouter["endpoints"], "list">;

/**
 * Ranked candidates for `model`, cached. Returns an EMPTY array (never throws)
 * when the model id is unroutable, the read fails, or we are inside the
 * post-failure cooldown: the caller treats "no candidates" as "cannot switch"
 * and surfaces the original provider error, which is strictly better than
 * replacing a real provider failure with a catalog failure.
 */
export async function loadEndpointCandidates(
  client: { readonly endpoints: EndpointsClient },
  model: string,
  now: number = Date.now(),
): Promise<ReadonlyArray<EndpointCandidate>> {
  const cached = cache.get(model);
  if (cached !== undefined && now - cached.cachedAtMs < CANDIDATE_TTL_MS) {
    return cached.candidates;
  }
  const cooldownUntil = cooldownUntilMsByModel.get(model);
  if (cooldownUntil !== undefined && now < cooldownUntil) return [];

  const target = splitModelId(model);
  if (target === null) {
    logger.warn("inference.openrouter.endpoint_candidates_unroutable_model", { model });
    return [];
  }

  let rows: ReadonlyArray<RawEndpointRow>;
  try {
    const response = await client.endpoints.list(
      { author: target.author, slug: target.slug },
      { timeoutMs: CANDIDATE_TIMEOUT_MS, retries: { strategy: "none" } },
    );
    rows = Array.isArray(response.data?.endpoints)
      ? (response.data.endpoints as ReadonlyArray<RawEndpointRow>)
      : [];
  } catch (err) {
    cooldownUntilMsByModel.set(model, now + CANDIDATE_FAILURE_COOLDOWN_MS);
    logger.warn("inference.openrouter.endpoint_candidates_unavailable", {
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const byTag = new Map<string, EndpointCandidate>();
  for (const row of rows) {
    const candidate = normalizeEndpointCandidate(row);
    if (candidate !== null && !byTag.has(candidate.tag)) byTag.set(candidate.tag, candidate);
  }
  const candidates = rankByUptime([...byTag.values()]);

  cache.delete(model);
  cache.set(model, { candidates, cachedAtMs: now });
  cooldownUntilMsByModel.delete(model);
  while (cache.size > CANDIDATE_CACHE_MAX_MODELS) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }

  return candidates;
}
