/**
 * Availability ranking for OpenRouter endpoints of ONE model.
 *
 * WHY THIS EXISTS (live evidence, harness scenario `provider-429-layer`,
 * `agents_dm/runtime-harness/fixtures/openrouter-429-shape.json`): a pin on
 * `deepinfra/fp4` returned 429 on 4/4 concurrent turn-sized requests while
 * `baidu/fp8` served the identical request in the same minute. The error
 * metadata read `limit_source = "upstream_provider_shared_pool"`,
 * `provider_error_code = "engine_overloaded"`. The operator had picked by
 * price and got a saturated pool. AVAILABILITY, not price, decides whether a
 * turn completes — so availability, not price, orders this list.
 *
 * REAL FIELDS ONLY. `PublicEndpoint` (installed `@openrouter/sdk@1.1.13`,
 * `esm/models/publicendpoint.d.ts`) publishes exactly these health signals:
 *
 * - `uptimeLast5m` / `uptimeLast30m` / `uptimeLast1d`: `number | null`.
 *   "Uptime percentage ... successful requests / (successful + error requests)
 *   * 100 ... Returns null if insufficient data." Range 0–100.
 * - `status`: an open enum over `{0, -1, -2, -3, -5, -10}`. `0` is normal; a
 *   NEGATIVE value is OpenRouter's own deranking of that endpoint.
 * - `latencyLast30m` / `throughputLast30m`: deliberately NOT used. The SDK
 *   documents them as "Only visible when authenticated with an API key or
 *   cookie; returns null for unauthenticated requests", and the catalogue
 *   client is keyless BY SECURITY INVARIANT (see
 *   `openrouter-public-catalog-client.ts`). Verified live on 2026-07-29: both
 *   came back `null` for all 21 endpoints of `deepseek/deepseek-v4-flash`.
 *   Ranking on a field that is structurally always null would be a fabricated
 *   metric.
 *
 * THE HONEST LIMIT OF UPTIME. OpenRouter's own definition excludes
 * rate-limited requests from the uptime ratio, so a 429 storm like the one
 * above does NOT by itself depress `uptimeLast*`. Uptime alone therefore
 * cannot see the exact failure that motivated this module. `status` can: a
 * negative value is OpenRouter routing traffic AWAY from an endpoint, which is
 * the signal that tracks overload/deranking. That is why the two are combined
 * as separate terms below rather than folded into one number.
 *
 * THE RANKING RULE, in order. A row sorts before another when the first
 * differing key below favours it:
 *
 *   1. HAS availability data (`availabilityScore !== null`) before HAS NOT.
 *      An endpoint the API has no data for is never treated as perfect and
 *      never outranks one with a measured score.
 *   2. NOT deranked (`status >= 0` or absent) before deranked (`status < 0`).
 *      Deranking outranks a score difference on purpose: OpenRouter steering
 *      traffic away is a stronger statement about retry risk than a few points
 *      of an uptime ratio that excludes rate limits.
 *   3. Higher `availabilityScore` first.
 *   4. Cheaper BASE prompt price first, then base completion price. This is
 *      the pre-existing ordering, demoted to a tiebreak — price still decides
 *      between two equally healthy endpoints.
 *   5. `tag` ascending, so the order is total and stable across refreshes.
 *
 * THE SCORE. A weighted mean of the uptime windows that are actually present,
 * renormalised over those windows so a missing one neither counts as zero nor
 * as 100:
 *
 *   score = Σ(weight_w × uptime_w) / Σ(weight_w)   over present windows w
 *   weights: last 5m = 0.5, last 30m = 0.3, last 1d = 0.2
 *
 * The short window dominates because the question this list answers is "will
 * my NEXT turn complete", not "was this endpoint good yesterday". The day
 * window still carries weight so one lucky five-minute sample cannot promote a
 * chronically flaky endpoint. `null` when no window has data.
 */

import type { ProviderEndpointOption } from "@shared/schemas/provider-endpoints.js";

/** Uptime window weights. Documented in the module header; keep in sync. */
const UPTIME_WINDOW_WEIGHTS = {
  last5m: 0.5,
  last30m: 0.3,
  last1d: 0.2,
} as const;

/** The uptime windows a raw row can carry, already bounded to 0–100 or null. */
export interface EndpointUptimeWindows {
  readonly uptimeLast5mPercent: number | null;
  readonly uptimeLast30mPercent: number | null;
  readonly uptimeLast1dPercent: number | null;
}

/**
 * Weighted mean of the uptime windows that are present, or `null` when the API
 * reported none. `null` means UNKNOWN and must never be rendered or compared
 * as a perfect score.
 */
export function computeAvailabilityScore(
  windows: EndpointUptimeWindows,
): number | null {
  const terms: ReadonlyArray<readonly [number, number | null]> = [
    [UPTIME_WINDOW_WEIGHTS.last5m, windows.uptimeLast5mPercent],
    [UPTIME_WINDOW_WEIGHTS.last30m, windows.uptimeLast30mPercent],
    [UPTIME_WINDOW_WEIGHTS.last1d, windows.uptimeLast1dPercent],
  ];

  let weightedSum = 0;
  let weightTotal = 0;
  for (const [weight, value] of terms) {
    if (value === null) continue;
    weightedSum += weight * value;
    weightTotal += weight;
  }
  if (weightTotal === 0) return null;

  const score = weightedSum / weightTotal;
  return Number.isFinite(score) ? score : null;
}

/**
 * Order two endpoints by the documented ranking rule (healthiest first).
 * Exported for direct testing of each tier.
 */
export function compareEndpointsByAvailability(
  a: ProviderEndpointOption,
  b: ProviderEndpointOption,
): number {
  // 1. Measured availability before unknown availability.
  const aHasScore = a.availabilityScore !== null;
  const bHasScore = b.availabilityScore !== null;
  if (aHasScore !== bHasScore) return aHasScore ? -1 : 1;

  // 2. Healthy before deranked.
  if (a.isDeranked !== b.isDeranked) return a.isDeranked ? 1 : -1;

  // 3. Higher score first (both null ⇒ no difference).
  const scoreOrder = (b.availabilityScore ?? 0) - (a.availabilityScore ?? 0);
  if (scoreOrder !== 0) return scoreOrder;

  // 4. Cheapest base rates as the tiebreak between equally healthy endpoints.
  //    Unpriced sorts last so it cannot look free.
  const priceOrder =
    (a.pricingInputPerMillion ?? Number.POSITIVE_INFINITY) -
    (b.pricingInputPerMillion ?? Number.POSITIVE_INFINITY);
  if (priceOrder !== 0) return priceOrder;
  const outputOrder =
    (a.pricingOutputPerMillion ?? Number.POSITIVE_INFINITY) -
    (b.pricingOutputPerMillion ?? Number.POSITIVE_INFINITY);
  if (outputOrder !== 0) return outputOrder;

  // 5. Total, stable order.
  return a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" });
}

/**
 * The endpoint to SUGGEST, or `null` when there is nothing honest to suggest.
 *
 * Only the top-ranked row qualifies, and only when it is both measured and not
 * deranked. Suggesting an endpoint whose availability the API could not report
 * would dress up an unknown as a recommendation. The suggestion is a HINT —
 * callers must never apply it to the operator's selection automatically.
 *
 * Expects `ranked` already ordered by `compareEndpointsByAvailability`.
 */
export function suggestedEndpointTagOf(
  ranked: ReadonlyArray<ProviderEndpointOption>,
): string | null {
  const best = ranked[0];
  if (best === undefined) return null;
  if (best.availabilityScore === null || best.isDeranked) return null;
  return best.tag;
}
