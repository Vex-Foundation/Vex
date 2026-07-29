/**
 * TURN STATE → ISLAND SHAPE. The pure derivation behind the Turn Activity
 * Island: one `StreamPreview` (plus the approval circuit-break) in, one view
 * descriptor out. No React, no motion — so every transition in the island's
 * life is unit-testable without rendering anything.
 *
 * Precedence, highest first:
 *  1. `phase === "error"` — a failed turn is never dressed as work.
 *  2. `awaitingApproval` — THE FREEZE. A pending signature stops the machine
 *     visibly: pin tone, no animation, "Awaiting signature". Trust is
 *     stillness; the island must never keep dancing while it waits for the
 *     user's pen, because motion here reads as progress that is not happening.
 *  3. `phase !== "streaming"` — the turn settled; only the reasoning stamp
 *     (if any reasoning happened at all) survives.
 *  4. The derived working status: thinking → calling → writing → working.
 */

import type { IslandSizePreset } from "../../../components/ui/dynamic-island.js";
import type { StreamPreview } from "../../../stores/streamStore.js";
import { reasonedStampLabel } from "../reasoning-stamp.js";

export type TurnIslandState =
  | "working"
  | "thinking"
  | "calling"
  | "writing"
  | "awaiting"
  | "error"
  | "settled";

export interface TurnIslandView {
  readonly state: TurnIslandState;
  readonly size: IslandSizePreset;
  /** The visible (and announced) status line. */
  readonly label: string;
  readonly tone: "neutral" | "accent" | "pin" | "error";
  /** Whether any in-island motion may run at all (the freeze kills it). */
  readonly animated: boolean;
  /** Whether the elapsed m:ss counter is mounted. */
  readonly showElapsed: boolean;
}

/** Safe generic only — raw provider error text never reaches the island. */
export const STREAM_ERROR_LABEL = "Stream error";

export function resolveTurnIslandView(
  preview: StreamPreview,
  awaitingApproval: boolean,
): TurnIslandView {
  const hasReasoning = preview.reasoningText.length > 0;

  if (preview.phase === "error") {
    return {
      state: "error",
      size: "row",
      label: STREAM_ERROR_LABEL,
      tone: "error",
      animated: false,
      showElapsed: false,
    };
  }

  if (preview.phase !== "streaming") {
    return {
      state: "settled",
      size: hasReasoning ? "stamp" : "hidden",
      label: hasReasoning ? reasonedStampLabel(preview.reasoningTokens) : "",
      tone: "neutral",
      animated: false,
      showElapsed: false,
    };
  }

  if (awaitingApproval) {
    return {
      state: "awaiting",
      size: "row",
      label: "Awaiting signature",
      tone: "pin",
      animated: false,
      showElapsed: true,
    };
  }

  switch (preview.status) {
    case "thinking":
      return {
        state: "thinking",
        size: "panel",
        label: "Thinking",
        tone: "accent",
        animated: true,
        showElapsed: true,
      };
    case "calling":
      return {
        state: "calling",
        size: "row",
        label: `Calling ${preview.toolName ?? "tool"}`,
        tone: "neutral",
        animated: true,
        showElapsed: true,
      };
    case "writing":
      // The answer streams BELOW the island; the island keeps the stamp the
      // thinking left behind so live→persisted reads as one object.
      return {
        state: "writing",
        size: "stamp",
        label: hasReasoning
          ? reasonedStampLabel(preview.reasoningTokens)
          : "Writing",
        tone: "neutral",
        animated: true,
        showElapsed: true,
      };
    case "working":
      return {
        state: "working",
        size: "pill",
        label: "Working",
        tone: "neutral",
        animated: true,
        showElapsed: true,
      };
    default: {
      const exhaustive: never = preview.status;
      throw new Error(`Unhandled stream status: ${String(exhaustive)}`);
    }
  }
}
