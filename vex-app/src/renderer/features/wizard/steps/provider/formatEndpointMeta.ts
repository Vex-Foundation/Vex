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

export function formatEndpointMeta(endpoint: ProviderEndpointOption): string {
  const parts: string[] = [];
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
