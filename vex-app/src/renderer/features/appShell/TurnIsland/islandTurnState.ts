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
import { classifyEngineFailure } from "@shared/engine-error-classification.js";
import { engineErrorCopy } from "@shared/engine-error-copy.js";
import type { StreamPreview } from "../../../stores/streamStore.js";
import { reasonedStampLabel } from "../reasoning-stamp.js";
import { resolveToolIdentity } from "../ToolLedger/toolIdentity.js";

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
  /** Classified error explanation (error state only) — fixed copy, never the trace. */
  readonly errorBody?: string;
  /** Whether any in-island motion may run at all (the freeze kills it). */
  readonly animated: boolean;
  /** Whether the elapsed m:ss counter is mounted. */
  readonly showElapsed: boolean;
}

/**
 * The compact inline register for a `working` round — the same word the
 * centred scene captions itself with, at island scale. The legacy "Working"
 * label is retired from the UI entirely (owner brief §7): a mid-turn round, a
 * resumed mission and a wake turn all get this instead, so "vexing" means one
 * thing everywhere and never appears twice on screen at once.
 */
const VEXING_LABEL = "vexing…";

/**
 * May the CENTRED particle scene own the chat column right now?
 *
 * `centredSceneEligible` is the transcript-evidence latch owned by
 * `SessionTranscript/turnPreview.ts` — this predicate only adds the conditions
 * that are visible in the preview itself. Kept pure and separate so the mount
 * decision is unit-testable without rendering a canvas.
 *
 * `awaitingApproval` is a FIRST-CLASS argument, not an afterthought: a pending
 * signature freezes this surface (see the precedence note at the top of this
 * file). A looping scene while we wait for the user's pen would read as
 * progress that is not happening — trust is stillness.
 */
export function showsCentredScene(
  preview: StreamPreview,
  centredSceneEligible: boolean,
  awaitingApproval: boolean,
): boolean {
  return (
    centredSceneEligible &&
    !awaitingApproval &&
    preview.phase === "streaming" &&
    preview.status === "working" &&
    preview.text.length === 0 &&
    preview.reasoningText.length === 0 &&
    preview.reasoningSegments.length === 0
  );
}

export function resolveTurnIslandView(
  preview: StreamPreview,
  awaitingApproval: boolean,
  /** The centred scene is mounted — the island must not state the same fact
   * a second time, so its `working` pill stands down. */
  centredSceneUp = false,
): TurnIslandView {
  // Reasoning is TURN-scoped: a turn that thought, called a tool, and is now
  // writing has an empty ACTIVE buffer but a settled segment behind it. Both
  // count, or the stamp would vanish at exactly the moment the turn had the
  // most thinking to show for itself.
  const hasReasoning =
    preview.reasoningText.length > 0 || preview.reasoningSegments.length > 0;

  if (preview.phase === "error") {
    // Bounded label -> category -> fixed copy. The classifier is total, so a
    // missing or unrecognized `errorType` lands on the honest `unknown`
    // wording rather than a generic "Stream error" that named nothing. Raw
    // provider text still never reaches the island — only the fixed copy of
    // the ONE shared classifier this strip, the error banner and the chat IPC
    // mapper all consult, so the three surfaces cannot disagree.
    const copy = engineErrorCopy(
      classifyEngineFailure({ errorType: preview.errorType }),
    );
    return {
      state: "error",
      size: "row",
      label: copy.title,
      errorBody: copy.body,
      tone: "error",
      animated: false,
      showElapsed: false,
    };
  }

  // Ahead of the settled branch, per the documented precedence: a turn that
  // stopped streaming BECAUSE it is waiting on a signature is not settled. The
  // stream ends the moment the tool call needs approval, so ordering these the
  // other way dressed a blocked turn as a finished one and dropped the one
  // label that tells the user the pen is with them.
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
      // The NAME the model used is a raw symbol; the card ledger already turns
      // it into a human title with its venue ("Calling KyberSwap · Swap
      // quote"), and the live island must read the same way — main hands this
      // lane the canonical dotted toolId, so the venue is provable here.
      // `CallingMark` resolves the same identity for the logo.
      return {
        state: "calling",
        size: "row",
        label:
          preview.toolName === null
            ? "Calling tool"
            : `Calling ${resolveToolIdentity(preview.toolName, null).title}`,
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
        size: centredSceneUp ? "hidden" : "pill",
        label: centredSceneUp ? "" : VEXING_LABEL,
        tone: "neutral",
        animated: true,
        showElapsed: !centredSceneUp,
      };
    default: {
      const exhaustive: never = preview.status;
      throw new Error(`Unhandled stream status: ${String(exhaustive)}`);
    }
  }
}
