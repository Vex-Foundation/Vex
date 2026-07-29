/**
 * The ONE "Reasoned" stamp grammar, shared by the live Turn Island (once
 * thinking ends) and the persisted transcript block, so a turn's reasoning
 * reads as the SAME object before and after it is written to the database —
 * the live→persisted handover should look like a settle, not a swap.
 *
 * Honest by construction: the token count and the duration are OPTIONAL
 * because the persisted DTO (contract C1) carries only the reasoning TEXT.
 * A count we do not have is omitted, never estimated from characters —
 * a fabricated "≈1.4K tokens" would be indistinguishable from a measured one.
 */

/** Compact token count — "1.2K tokens". */
function formatTokenCount(count: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}

/**
 * "Reasoned", "Reasoned · 1.2K tokens", "Reasoned · 1.2K tokens · 8s".
 * Non-finite / negative inputs are treated as unknown and simply omitted.
 */
export function reasonedStampLabel(
  tokens: number | null,
  durationMs: number | null = null,
): string {
  const parts: string[] = ["Reasoned"];
  if (tokens !== null && Number.isFinite(tokens) && tokens > 0) {
    parts.push(`${formatTokenCount(tokens)} tokens`);
  }
  if (durationMs !== null && Number.isFinite(durationMs) && durationMs >= 0) {
    parts.push(`${Math.round(durationMs / 1000)}s`);
  }
  return parts.join(" · ");
}
