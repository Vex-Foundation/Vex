/**
 * Display strings for one OpenRouter endpoint row in the provider select.
 *
 * Prices are BASE rates: OpenRouter also publishes conditional overrides
 * (long-context tiers, time windows) that main deliberately does not model, so
 * every price rendered here is labelled "base" and is never presented as a
 * total. Reuses the model-picker formatters so both lists read identically.
 */

import type { ProviderEndpointOption } from "@shared/schemas/provider-endpoints.js";
import { formatContextLength, formatPrice } from "./formatModelMeta.js";

export function formatEndpointPricing(
  endpoint: ProviderEndpointOption,
): string | null {
  const prices: string[] = [];
  if (endpoint.pricingInputPerMillion !== null) {
    prices.push(`${formatPrice(endpoint.pricingInputPerMillion)} in`);
  }
  if (endpoint.pricingOutputPerMillion !== null) {
    prices.push(`${formatPrice(endpoint.pricingOutputPerMillion)} out`);
  }
  if (prices.length === 0) return null;
  return `${prices.join(" / ")} per 1M (base)`;
}

/** True when the endpoint prices prompt caching in either direction. */
export function hasCachePricing(endpoint: ProviderEndpointOption): boolean {
  return (
    endpoint.pricingCacheReadPerMillion !== null ||
    endpoint.pricingCacheWritePerMillion !== null
  );
}

/**
 * Uptime for the row, or `null` when OpenRouter reported no window.
 *
 * A missing score renders as an explicit absence upstream — NEVER as "100%".
 * The label names the dominant window (5m) because that is what the ranking
 * weights most, and the number is the combined `availabilityScore` the list is
 * actually ordered by, so the row cannot show one figure and sort on another.
 */
export function formatEndpointUptime(
  endpoint: ProviderEndpointOption,
): string | null {
  // Tolerant reader (rules/90): uptime is a DISPLAY field. The IPC schema
  // guarantees the key, but a stale renderer bundle or an older cached payload
  // must degrade to "unknown" rather than crash the provider panel — this is
  // not a financially-consumed value, so absence is rendered, not thrown.
  const score = endpoint.availabilityScore;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return `${score.toFixed(1)}% uptime`;
}

export function formatEndpointMeta(endpoint: ProviderEndpointOption): string {
  const parts: string[] = [];
  const uptime = formatEndpointUptime(endpoint);
  // Availability leads the row: it is what decides whether a turn completes.
  if (uptime !== null) parts.push(uptime);
  else parts.push("uptime unknown");
  if (endpoint.isDeranked) parts.push("deranked by OpenRouter");
  if (endpoint.contextLength !== null) {
    parts.push(`${formatContextLength(endpoint.contextLength)} ctx`);
  }
  const pricing = formatEndpointPricing(endpoint);
  if (pricing !== null) parts.push(pricing);
  if (hasCachePricing(endpoint)) parts.push("caching priced");
  if (endpoint.quantization !== null && endpoint.quantization !== "unknown") {
    parts.push(endpoint.quantization);
  }
  return parts.join(" · ");
}
