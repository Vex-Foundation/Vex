import type { ProviderModelOption } from "@shared/schemas/provider.js";
import { usdDecimalFromNumber } from "@shared/usd-per-million.js";

export function formatContextLength(value: number): string {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}m`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/**
 * Exact USD decimal text -> "$0.14375", "$11.5", "$1,250": every digit the
 * provider published, thousands grouped, never rounded. A Vex Inference
 * price is what is charged, so a shorter figure would understate it.
 */
export function formatUsdPerMillion(decimalText: string): string {
  const [whole = "0", fraction] = decimalText.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? `$${grouped}` : `$${grouped}.${fraction}`;
}

/**
 * A per-1M price that crossed as a number (the OpenRouter endpoint list) ->
 * its published digits ("$0.575", "$11.5"), via `usdDecimalFromNumber`.
 */
export function formatPrice(value: number): string {
  const text = usdDecimalFromNumber(value);
  return text === null ? "Not available" : formatUsdPerMillion(text);
}

export function formatModelMeta(model: ProviderModelOption): string {
  const parts: string[] = [];
  if (model.contextLength !== null) {
    parts.push(`${formatContextLength(model.contextLength)} ctx`);
  }

  const prices: string[] = [];
  if (model.pricingInputPerMillion !== null) {
    prices.push(`${formatUsdPerMillion(model.pricingInputPerMillion)} in`);
  }
  if (model.pricingOutputPerMillion !== null) {
    prices.push(`${formatUsdPerMillion(model.pricingOutputPerMillion)} out`);
  }
  if (prices.length > 0) parts.push(`${prices.join(" / ")} per 1M`);
  return parts.join(" · ");
}
