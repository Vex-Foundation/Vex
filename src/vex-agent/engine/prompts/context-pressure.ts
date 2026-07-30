/**
 * Context-pressure banner — what the agent is told about its own context budget.
 *
 * REWRITTEN for compaction v2, and the reason matters more than the wording.
 *
 * The old banner was DIRECTIVE: it told the agent its next turn "MUST call
 * compact_now", that mutations were blocked until it did, and at critical that
 * compact_now was "the only allowed action". Under v2 all three statements are
 * false. The runtime forks a summarization branch on its own at the warning
 * band, applies the result automatically at critical, and falls back to a
 * deterministic compaction if the branch fails. The agent is no longer the
 * mechanism — it is a bystander who deserves an accurate status report.
 *
 * Two failure modes this file exists to prevent:
 *
 *   1. Naming a tool that does not exist. `compact_now` was removed. A banner
 *      instructing the model to call it produces a hallucinated tool call and a
 *      wasted turn, every turn, at exactly the moment turns are most expensive.
 *      A test greps every output of this switch for removed tool names.
 *
 *   2. Telling the agent it is blocked when it is not. While a preparation is
 *      live the barrier does NOT strip mutating tools (contract C8). Copy that
 *      says "mutations are blocked" would make the agent stop doing work it is
 *      still permitted — and fully capable — of doing.
 *
 * `compact_apply` is named ONLY when a validated summary is ready, because that
 * is exactly when the tool is in the catalog. Naming it earlier would advertise
 * something the model cannot see.
 *
 * Empty string when band is "normal" so the prompt stack omits this section
 * entirely (legacy convention: `buildPromptStack` filters empty layers).
 */

import type { ContextUsageBand } from "@vex-agent/engine/core/context-band.js";
import type { PreparationPressureState } from "@vex-agent/engine/core/preparation-pressure-state.js";
import {
  barrierBypassAllowed,
  hasCompactionSummaryReady,
} from "@vex-agent/engine/core/preparation-pressure-state.js";

export function buildContextPressureBanner(
  band: ContextUsageBand,
  fraction: number,
  preparationState: PreparationPressureState = { kind: "none" },
): string {
  const pct = (fraction * 100).toFixed(1);
  // One H1 per turn layer (P3 heading discipline): the banner used to be an
  // unheaded bracketed line floating between two headed layers.
  const heading = "# Context Pressure\n\n";
  const ready = hasCompactionSummaryReady(preparationState);
  const applyLine = ready
    ? " A prepared compaction is READY — you may call compact_apply to take it now, at a moment you choose."
    : "";

  switch (band) {
    case "normal":
      return "";

    case "warning":
      // The old copy promised "compact will trigger at ~88%". Under v2 the
      // background preparation starts HERE, at 80%, so that sentence named the
      // wrong number and the wrong mechanism.
      return (
        heading +
        `[Context at ${pct}%. The runtime prepares a compaction in the background from this point on; ` +
        `you do not need to do anything. Finish the current subtask cleanly rather than starting a large new one.` +
        applyLine +
        `]`
      );

    case "barrier":
      if (barrierBypassAllowed(preparationState)) {
        // Informational, NOT directive — and explicitly NOT a block notice,
        // because with the bypass active the mutating surface is intact.
        return (
          heading +
          `[Context at ${pct}%. A compaction is being prepared in the background and the runtime will apply it ` +
          `automatically. Your full tool set remains available — continue working normally.` +
          applyLine +
          `]`
        );
      }
      // No live preparation (or it failed): today's restriction is real, so say
      // so — but as a statement of runtime behaviour, not an instruction the
      // agent has no tool to satisfy.
      return (
        heading +
        `[Context at ${pct}%. Mutating tools are unavailable at this pressure. The runtime is retrying the ` +
        `background compaction and will fall back to a deterministic one if that fails — no tool call is ` +
        `required from you. Continue with read-only work; the full tool set returns once the compaction lands.]`
      );

    case "critical":
      return (
        heading +
        `[Context at ${pct}%. The runtime is compacting this conversation now — applying the prepared ` +
        `summary if one is ready, otherwise a deterministic fallback. No tool call is required from you. ` +
        `Wrap up the current thought; the next turn will have room again.]`
      );
  }
}
