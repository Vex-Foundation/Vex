/**
 * Pure presentation of ONE TURN's usage rollup as the micro-label stats groups:
 * tokens (in/out compact), cache-hit percent, and cost. Display-only — this
 * never touches content going to the model. Wall time is deliberately absent:
 * the usage DTO carries no duration (named gap, board 2026-08-20).
 *
 * A turn is a LOOP of model rounds, so the two token figures are deliberately
 * NOT symmetric and must not be made so:
 *
 *   IN  = `latestRoundPromptTokens` - a SNAPSHOT of the turn's last request.
 *         Every round re-sends the whole conversation, so a sum would count the
 *         same tokens N times.
 *   OUT = `turnCompletionTokens` - a RUNNING SUM over every round, because
 *         every round generates NEW billed tokens (tool-call arguments
 *         included; the provider bills them as completion tokens).
 *
 * Cost is likewise the turn's sum. `turnUsageRollupDtoSchema` carries the full
 * contract; this module only renders it.
 */

import type { TurnUsageRollupDto } from "@shared/schemas/usage.js";

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
export function cacheHitPercent(usage: TurnUsageRollupDto): number | null {
  if (usage.latestRoundPromptTokens === 0) return null;
  return Math.round(
    (usage.latestRoundCachedTokens / usage.latestRoundPromptTokens) * 100,
  );
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
export function turnStatGroups(usage: TurnUsageRollupDto): readonly string[] {
  const groups: string[] = [];
  if (usage.latestRoundPromptTokens > 0 || usage.turnCompletionTokens > 0) {
    groups.push(
      `${formatTokens(usage.latestRoundPromptTokens)} in / ${formatTokens(usage.turnCompletionTokens)} out`,
    );
  }
  const cacheHit = cacheHitPercent(usage);
  if (cacheHit !== null && usage.latestRoundCachedTokens > 0) {
    groups.push(`${cacheHit}% cached`);
  }
  const cost = formatCost(usage.turnCost, usage.currency);
  if (cost !== null) groups.push(cost);
  // A multi-round turn SAYS it is one. Without this the reader cannot tell an
  // aggregate from a single request, and the asymmetry above (snapshot input,
  // summed output) is invisible - which is precisely how the old single-row
  // read passed for a turn figure for so long.
  if (usage.roundCount > 1) groups.push(`${usage.roundCount} rounds`);
  return groups;
}
