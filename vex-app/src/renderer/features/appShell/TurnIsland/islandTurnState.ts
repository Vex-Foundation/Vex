/**
 * TURN STATE TO LIVE ROW. The pure derivation behind the turn's live row (the
 * Turn Activity Island, docs/design/R3-MINIMAL.md section 6): one
 * `StreamPreview` (plus the approval circuit-break) in, one view descriptor
 * out. No React, no motion - so every transition in the row's life is
 * unit-testable without rendering anything.
 *
 * Precedence, highest first:
 *  1. `phase === "error"` - a failed turn is never dressed as work.
 *  2. `awaitingApproval` - THE FREEZE. A pending decision stops the machine
 *     visibly: pin tone, no animation, "Waiting for approval". Trust is
 *     stillness; the row must never keep moving while it waits for the
 *     reader, because motion here reads as progress that is not happening.
 *  3. A tool round whose stream is `done` with a tool name - the tool is
 *     RUNNING. The engine executes the batch after the provider stream ends
 *     and persists the round only afterwards, so this is exactly the window
 *     in which the tool runs.
 *  4. `phase !== "streaming"` - the turn settled; only the reasoning stamp
 *     (if any reasoning happened at all) survives.
 *  5. The derived working status: thinking, calling, writing, working, where
 *     `working` is split by what the engine has reported: no lease yet on the
 *     send's placeholder is PREPARING, anything else is WAITING FOR THE MODEL
 *     (the next provider round).
 *
 * The words are the Vex state words of the design ("Working", "Thinking",
 * "Writing", "Waiting for approval"), so the live row, the title bar chip and
 * the Vex sidebar say one thing. Every visible state is the one live-row
 * shape (`panel`, height from its content); only a settled turn with nothing
 * to show is `hidden`.
 *
 * Every phase is derived from events that already exist (stream deltas, the
 * transcript append, the control-state lease). No timer, no poll, and no
 * provider text: labels are fixed copy plus the resolved tool title.
 */

import type { IslandSizePreset } from "../../../components/ui/dynamic-island.js";
import { classifyEngineFailure } from "@shared/engine-error-classification.js";
import { engineErrorCopy } from "@shared/engine-error-copy.js";
import type { StreamPreview } from "../../../stores/streamStore.js";
import { reasonedStampLabel } from "../reasoning-stamp.js";
import { resolveToolIdentity } from "../ToolLedger/toolIdentity.js";
import { PENDING_TURN_STREAM_ID } from "../SessionTranscript/turnPreview.js";

export type TurnIslandState =
  | "working"
  | "thinking"
  | "calling"
  | "running"
  | "writing"
  | "awaiting"
  | "error"
  | "settled";

/**
 * WHAT THE TURN IS DOING, as one machine label (U-3). Stamped on the island as
 * `data-vex-turn-phase` and announced to assistive tech. "Waiting for a wake"
 * is deliberately not here: a parked run has released its lease and has no
 * turn in flight, and `SessionSleepBanner` owns that state.
 */
export type TurnPhase =
  | "preparing"
  | "waiting_provider"
  | "reasoning"
  | "calling_tool"
  | "running_tool"
  | "writing"
  | "awaiting_approval"
  | "error"
  | "settled";

export interface TurnIslandView {
  readonly state: TurnIslandState;
  readonly phase: TurnPhase;
  /**
   * The row's scope, 13 muted beside the word: which part of the wait this is
   * ("Waiting for the model"), or what the turn already thought ("Reasoned ·
   * 1.2K tokens") while it writes.
   */
  readonly detail?: string;
  readonly size: IslandSizePreset;
  /** The visible (and announced) status line. */
  readonly label: string;
  readonly tone: "neutral" | "accent" | "pin" | "error";
  /** Classified error explanation (error state only) — fixed copy, never the trace. */
  readonly errorBody?: string;
  /** Sanitized real cause from the stream error delta (error state only). */
  readonly errorDetail?: string;
  /** Whether any in-island motion may run at all (the freeze kills it). */
  readonly animated: boolean;
  /** Whether the elapsed m:ss counter is mounted. */
  readonly showElapsed: boolean;
}

/**
 * The word for a `working` round: a mid-turn round, a resumed mission and a
 * wake turn all read "Working", the same word the title bar chip and the Vex
 * sidebar show for the turn (docs/design/R3-MINIMAL.md section 5.2).
 */
const WORKING_LABEL = "Working";

export const PREPARING_DETAIL = "Preparing the turn";
export const WAITING_PROVIDER_DETAIL = "Waiting for the model";

export function resolveTurnIslandView(
  preview: StreamPreview,
  awaitingApproval: boolean,
  /** The engine reported this session's runner lease as held. */
  leaseHeld = false,
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
    // provider text still never reaches the row - only the fixed copy of
    // the ONE shared classifier this strip, the error banner and the chat IPC
    // mapper all consult, so the three surfaces cannot disagree.
    const copy = engineErrorCopy(
      classifyEngineFailure({ errorType: preview.errorType }),
    );
    return {
      state: "error",
      phase: "error",
      size: "panel",
      label: copy.title,
      errorBody: copy.body,
      // The sanitized REAL cause (decree 2026-08-02) rides beside the fixed
      // copy - already stripped of secrets at the main bridge.
      ...(preview.errorDetail !== null ? { errorDetail: preview.errorDetail } : {}),
      tone: "error",
      animated: false,
      showElapsed: false,
    };
  }

  // Ahead of the settled branch, per the documented precedence: a turn that
  // stopped streaming BECAUSE it is waiting on a decision is not settled. The
  // stream ends the moment the tool call needs approval, so ordering these the
  // other way dressed a blocked turn as a finished one and dropped the one
  // word that tells the reader the decision is theirs.
  if (awaitingApproval) {
    return {
      state: "awaiting",
      phase: "awaiting_approval",
      size: "panel",
      label: "Waiting for approval",
      tone: "pin",
      animated: false,
      showElapsed: true,
    };
  }

  if (preview.phase === "done" && preview.toolName !== null) {
    return {
      state: "running",
      phase: "running_tool",
      size: "panel",
      label: `Running ${resolveToolIdentity(preview.toolName, null).title}`,
      tone: "neutral",
      animated: true,
      showElapsed: true,
    };
  }

  if (preview.phase !== "streaming") {
    return {
      state: "settled",
      phase: "settled",
      size: hasReasoning ? "panel" : "hidden",
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
        phase: "reasoning",
        size: "panel",
        label: "Thinking",
        tone: "accent",
        animated: true,
        showElapsed: true,
      };
    case "calling":
      // The NAME the model used is a raw symbol; the step rows already turn
      // it into a human title with its venue ("Calling KyberSwap · Swap
      // quote"), and the live row must read the same way - main hands this
      // lane the canonical dotted toolId, so the venue is provable here.
      // `CallingMark` resolves the same identity for the logo.
      return {
        state: "calling",
        phase: "calling_tool",
        size: "panel",
        label:
          preview.toolName === null
            ? "Calling tool"
            : `Calling ${resolveToolIdentity(preview.toolName, null).title}`,
        tone: "neutral",
        animated: true,
        showElapsed: true,
      };
    case "writing":
      // The answer streams BELOW the row. The row says "Writing" and keeps
      // the stamp the thinking left behind as its scope, so the handover to
      // the persisted Reasoned row reads as one object.
      return {
        state: "writing",
        phase: "writing",
        size: "panel",
        label: "Writing",
        ...(hasReasoning
          ? { detail: reasonedStampLabel(preview.reasoningTokens) }
          : {}),
        tone: "neutral",
        animated: true,
        showElapsed: true,
      };
    case "working":
      // The in-flow tail status: this row IS the pending surface. The centred
      // viewport scene it once stood down for is retired - its viewport-tall
      // child inflated the scrollport's scrollable overflow and lifted the
      // sticky composer seat off the floor.
      // The send's placeholder before the engine has taken the lease is
      // still being PREPARED (admission, provider load, the lease itself).
      // Once the lease is held, or on a real round that has not spoken yet
      // (the round after a tool batch), the engine is at the provider.
      const preparing =
        preview.streamId === PENDING_TURN_STREAM_ID && !leaseHeld;
      return {
        state: "working",
        phase: preparing ? "preparing" : "waiting_provider",
        detail: preparing ? PREPARING_DETAIL : WAITING_PROVIDER_DETAIL,
        size: "panel",
        label: WORKING_LABEL,
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
