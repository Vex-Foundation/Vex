/**
 * The ONE "Thought" stamp grammar, shared by the live Turn Island (once
 * thinking ends) and the persisted transcript block, so a turn's reasoning
 * reads as the SAME object before and after it is written to the database —
 * the live→persisted handover should look like a settle, not a swap.
 *
 * The word is VEX Cloud's (docs/design/H3-DESKTOP.md Appendix A.7; Cloud's
 * EC-07 and its trace labels, `h3-merged/js/data.js` TRACE_LABEL): a turn
 * reopened from history reads "Thought" with no total, since no duration is
 * stored; "Thought for 2.8s" is the live turn clock's reading after a turn
 * watched live (`ReasonedBlock`). Cloud marks "Thought", "Thought for {s}"
 * and "{n} steps" DRAFT.
 *
 * Honest by construction: the token count and the duration are OPTIONAL
 * because the persisted DTO (contract C1) carries only the reasoning TEXT.
 * A count we do not have is omitted, never estimated from characters —
 * a fabricated "≈1.4K tokens" would be indistinguishable from a measured one.
 */

/** The stamp's word: a turn that thought, with no total. */
export const THOUGHT_WORD = "Thought";

/** Compact token count — "1.2K tokens". */
function formatTokenCount(count: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}

/**
 * "Thought", "Thought · 1.2K tokens", "Thought · 1.2K tokens · 8s".
 * Non-finite / negative inputs are treated as unknown and simply omitted.
 */
export function reasonedStampLabel(
  tokens: number | null,
  durationMs: number | null = null,
): string {
  const parts: string[] = [THOUGHT_WORD];
  if (tokens !== null && Number.isFinite(tokens) && tokens > 0) {
    parts.push(`${formatTokenCount(tokens)} tokens`);
  }
  if (durationMs !== null && Number.isFinite(durationMs) && durationMs >= 0) {
    parts.push(`${Math.round(durationMs / 1000)}s`);
  }
  return parts.join(" · ");
}

/**
 * "1 step", "5 steps": the steps a turn took that the reader can count in it
 * (`SessionTranscript/turnSteps.ts`). `null` for no count, never "0 steps".
 */
export function stepsLabel(steps: number | null): string | null {
  if (steps === null || !Number.isInteger(steps) || steps <= 0) return null;
  return steps === 1 ? "1 step" : `${String(steps)} steps`;
}
