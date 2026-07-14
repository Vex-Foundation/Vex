/**
 * Context-pressure banner — informational at warning, directive at barrier+.
 *
 * Empty string when band is "normal" so the prompt stack omits this section
 * entirely (legacy convention: `buildPromptStack` filters empty layers).
 */

import type { ContextUsageBand } from "@vex-agent/engine/core/context-band.js";

export function buildContextPressureBanner(
  band: ContextUsageBand,
  fraction: number,
): string {
  const pct = (fraction * 100).toFixed(1);
  switch (band) {
    case "normal":
      return "";
    case "warning":
      return `[Context at ${pct}% — compact will trigger at ~88%. Finish current subtask cleanly.]`;
    case "barrier":
      return [
        `[ACTION REQUIRED: Context at ${pct}%.`,
        `Your next turn MUST call compact_now(conversation_summary, preserve_md, thread_themes_hints).`,
        `Mutations are blocked until compaction completes. Compact first, then trust the current Tool Map for what remains callable.`,
        `]`,
      ].join(" ");
    case "critical":
      return [
        `[CRITICAL: Context at ${pct}%.`,
        `compact_now is the only allowed action. Runtime will trigger a deterministic fallback compact if you do not call it this turn.`,
        `]`,
      ].join(" ");
  }
}
