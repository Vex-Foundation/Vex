/**
 * Pure presentation of one turn's usage row as the micro-label stats groups:
 * tokens (in/out compact), cache-hit percent, and cost. Display-only — this
 * never touches content going to the model. Wall time is deliberately absent:
 * the usage DTO carries no duration (named gap, board 2026-08-20).
 */

import type { TurnUsageDto } from "@shared/schemas/usage.js";

/** Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits). */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
  return `${scaled(n / 1_000_000)}M`;
}

/**
 * Cache-hit share of the prompt side, rounded to an integer percent;
 * null when no prompt tokens were billed (a 0/0 read is not "0% cached").
 */
export function cacheHitPercent(usage: TurnUsageDto): number | null {
  if (usage.promptTokens === 0) return null;
  return Math.round((usage.cachedTokens / usage.promptTokens) * 100);
}

/**
 * Cost display: fixed 4 decimals under $1 (sub-cent turns stay visible),
 * 2 decimals from $1 up. Null cost (NUMERIC overflow) renders nothing —
 * a missing measurement is never printed as $0.
 */
export function formatCost(cost: number | null, currency: string): string | null {
  if (cost === null || !Number.isFinite(cost)) return null;
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return cost < 1 ? `${symbol}${cost.toFixed(4)}` : `${symbol}${cost.toFixed(2)}`;
}

/**
 * The displayable stat groups for one turn, in reading order. A group whose
 * measurement is absent drops out whole rather than printing a zero.
 */
export function turnStatGroups(usage: TurnUsageDto): readonly string[] {
  const groups: string[] = [];
  if (usage.promptTokens > 0 || usage.completionTokens > 0) {
    groups.push(
      `${formatTokens(usage.promptTokens)} in / ${formatTokens(usage.completionTokens)} out`,
    );
  }
  const cacheHit = cacheHitPercent(usage);
  if (cacheHit !== null && usage.cachedTokens > 0) {
    groups.push(`${cacheHit}% cached`);
  }
  const cost = formatCost(usage.cost, usage.currency);
  if (cost !== null) groups.push(cost);
  return groups;
}
