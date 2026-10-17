/**
 * THE TURN'S LIVE ROW - every move Vex makes in the current turn, as one step
 * row at the tail of the transcript (docs/design/R3-MINIMAL.md section 6).
 *
 * DESIGN INTENT. The waiting moment is not dressed up with a louder loader -
 * it is filled with the only thing that is actually true, and filled
 * IMMEDIATELY: the row mounts on the SEND, not on the first provider delta, so
 * the send can never read as a no-op. A live row always carries a fill, a
 * word and a timer: the fill (working solid, thinking hatch, waiting the
 * target), the word in blue 500, its scope in 13 muted, the real elapsed time
 * in the mono 12 blue at the right. The thoughts the turn has finished fold
 * into quiet rows above it; the live one streams in full beneath a Thinking
 * row, so waiting is spent reading rather than watching a spinner.
 *
 * States (derived purely in `islandTurnState.ts` from the `streamStore`
 * preview, never from timers):
 *
 *   Working   the turn has begun and nothing is classified yet. This is the
 *             state the SEND opens on (`turnPreview.ts`). Its scope says
 *             "Preparing the turn" until the engine reports the lease, then
 *             "Waiting for the model"
 *   Thinking  the full reasoning streams under the row as live markdown
 *             (`LiveReasoning`) - no window, no clipping; unreadable is not a
 *             design
 *   Calling   the protocol/tool mark (contract C5) + "Calling {tool}"
 *   Running   the same row once the provider stream has ended and the tool
 *             is executing ("Running {tool}"), until its round persists
 *   Writing   the ANSWER streams below the row; what the turn thought rides
 *             as its scope ("Reasoned · 1.2K tokens")
 *
 * Preserved from the working strip it replaces: the elapsed m:ss counter, the
 * awaiting-approval FREEZE (all motion stops, the target fill - trust equals
 * stillness), the visually-hidden `role="status"` announcements (phase +
 * status change a few times per turn; the growing text is never announced),
 * and the error branch, which shows a safe generic line and NEVER the trace.
 *
 * Surface law: no box, no glass, no glow - the quiet rules above and below
 * are the row's frame (`.vex-island` and `.vex-live-row`, chat-transcript.css,
 * on the `dynamic-island` primitive, whose shape stays one live-row size so it
 * never morphs). `prefers-reduced-motion` is honored by the primitive.
 * `data-vex-island-state` is the test seam.
 */

import type { JSX } from "react";
import {
  DynamicContainer,
  DynamicIsland,
  DynamicIslandProvider,
  useIslandSizeSync,
} from "../../../components/ui/dynamic-island.js";
import type { StreamPreview } from "../../../stores/streamStore.js";
import { cn } from "../../../lib/utils.js";
import { Swatch, type SwatchState } from "../../../components/ui/swatch.js";
import { ProtocolMark } from "../ToolLedger/ProtocolMark.js";
import { toolGlyph } from "../ToolLedger/toolGlyph.js";
import { resolveToolIdentity } from "../ToolLedger/toolIdentity.js";
import { ElapsedCounter } from "./ElapsedCounter.js";
import { LiveReasoning } from "./LiveReasoning.js";
import { ReasoningSegments } from "./ReasoningSegments.js";
import {
  resolveTurnIslandView,
  type TurnIslandView,
} from "./islandTurnState.js";

/**
 * The fill before the word - status by fill (docs/design/R3-MINIMAL.md
 * sections 1.6 and 6). Live work is the solid fill, thinking the hatch, the
 * awaiting freeze the target (it never moves), an error the ink cross, a
 * settled stamp the solid square. No state here steps or animates.
 */
function islandSwatch(view: TurnIslandView): SwatchState {
  if (view.state === "error") return "error";
  if (view.state === "awaiting") return "awaiting";
  if (view.state === "thinking") return "thinking";
  return "done";
}

/**
 * THE WORD behind its fill: the title of the live row in blue 500 (ink for a
 * failure). The fill carries the state; the word repeats it.
 */
function StatusWord({
  label,
  view,
}: {
  readonly label: string;
  readonly view: TurnIslandView;
}): JSX.Element {
  return (
    <>
      <span aria-hidden className="vex-step__fill">
        <Swatch state={islandSwatch(view)} size={10} />
      </span>
      <span data-vex-island-label="" className="vex-step__title">
        {label}
      </span>
    </>
  );
}

/** The elapsed clock: the mono 12, tabular, in the blue at the row's right. */
function IslandClock({ startedAtMs }: { readonly startedAtMs: number }): JSX.Element {
  return (
    <span data-vex-island-clock="" className="flex flex-none items-center">
      <ElapsedCounter startedAtMs={startedAtMs} />
    </span>
  );
}

/**
 * The row's scope, 13 muted beside the word. Fixed copy only, and
 * aria-hidden because the status region already announces it.
 */
function IslandScope({ detail }: { readonly detail: string | undefined }): JSX.Element | null {
  if (detail === undefined) return null;
  return (
    <span aria-hidden="true" data-vex-island-detail="" className="vex-step__word min-w-0 truncate">
      {detail}
    </span>
  );
}

/** The mark beside "Calling {tool}" — venue logo when C5 proves one. */
function CallingMark({ toolName }: { readonly toolName: string }): JSX.Element {
  // Live previews carry only the tool NAME (no args yet), so identity here
  // rests on the prefix map alone — the fail-closed args path is the tool
  // card's job, once the persisted act exists.
  const identity = resolveToolIdentity(toolName, null);
  return (
    <ProtocolMark
      protocol={identity.protocol}
      fallbackGlyph={toolGlyph(toolName)}
      size={14}
    />
  );
}

function IslandBody({
  view,
  preview,
}: {
  readonly view: TurnIslandView;
  readonly preview: StreamPreview;
}): JSX.Element | null {
  useIslandSizeSync(view.size);

  if (view.size === "hidden") return null;

  const row = (
    <span
      className={cn(
        "vex-step vex-live-row",
        view.state === "settled" && "vex-live-row--settled",
      )}
    >
      {(view.state === "calling" || view.state === "running")
      && preview.toolName !== null ? (
        <span className="vex-step__mark">
          <CallingMark toolName={preview.toolName} />
        </span>
      ) : null}
      {/* A Thinking row reads "Thinking:" - a speaker label introducing the
          words below it. The colon lives here and not in the view descriptor
          because the same label is announced to screen readers, where
          trailing punctuation is noise. */}
      <StatusWord
        label={view.state === "thinking" ? `${view.label}:` : view.label}
        view={view}
      />
      <IslandScope detail={view.detail} />
      <span aria-hidden className="vex-step__spacer" />
      {view.showElapsed ? <IslandClock startedAtMs={preview.startedAtMs} /> : null}
    </span>
  );

  if (view.state === "thinking") {
    return (
      <DynamicContainer className="flex flex-col">
        {row}
        <LiveReasoning text={preview.reasoningText} />
      </DynamicContainer>
    );
  }

  return <DynamicContainer className="flex w-full flex-col">{row}</DynamicContainer>;
}

export function TurnIsland({
  preview,
  awaitingApproval = false,
  leaseHeld = false,
}: {
  readonly preview: StreamPreview;
  /**
   * The active session has at least one pending approval. The row FREEZES:
   * every animation stops and the word becomes "Waiting for approval" behind
   * the target fill.
   * Derived upstream (SessionTranscript shares ApprovalsRegion's pending
   * query) so the stream store stays decoupled from TanStack Query.
   */
  readonly awaitingApproval?: boolean;
  /**
   * The engine reported the session's runner lease as held (control-state
   * push). Splits the Working row's scope into "Preparing the turn" and
   * "Waiting for the model"; nothing else reads it.
   */
  readonly leaseHeld?: boolean;
}): JSX.Element {
  const view = resolveTurnIslandView(preview, awaitingApproval, leaseHeld);
  // A running tool is live work even though its provider stream is `done`.
  const live = preview.phase === "streaming" || view.state === "running";

  return (
    <div
      data-vex-island-state={view.state}
      data-vex-turn-phase={view.phase}
      data-vex-stream-awaiting={view.state === "awaiting" ? "" : undefined}
      className="flex flex-col"
    >
      {/* Announced: phase + status only. The growing text is NEVER a live
          region - that would spam a screen reader token by token; the
          persisted transcript row is the canonical content. */}
      <span className="sr-only" role="status">
        <span>
          {preview.phase === "error"
            ? "Vex stream error"
            : preview.phase === "done" && !live
              ? "Vex responded"
              : "Vex is responding"}
        </span>
        {live ? (
          <span>
            {view.detail === undefined ? view.label : `${view.label} ${view.detail}`}
          </span>
        ) : null}
      </span>
      {/* The thoughts this turn has already finished, folded. They sit ABOVE
          the live row because they are behind it in time - the turn reads top
          to bottom as it happened. They persist across tool calls and across
          provider rounds; only the end of the TURN retires them. */}
      <ReasoningSegments segments={preview.reasoningSegments} />
      {/* THE FREEZE reaches the SHELL, not just the word: while a decision is
          pending every content cross-fade becomes a hard cut, so the row goes
          genuinely still instead of springing into the awaiting state. */}
      <DynamicIslandProvider
        initialSize={view.size}
        frozen={view.state === "awaiting"}
      >
        {/* `data-vex-sweep` marks the live tool row (the seam the running
            row has always carried). */}
        <div
          data-vex-sweep={
            view.state === "calling" || view.state === "running"
              ? "running"
              : undefined
          }
        >
          <DynamicIsland
            id="vex-turn-island"
            className="vex-island"
            data-vex-island-tone={view.tone}
          >
            <IslandBody view={view} preview={preview} />
          </DynamicIsland>
        </div>
      </DynamicIslandProvider>
      {view.state === "error" && view.errorBody !== undefined ? (
        // Category copy - the second line explains what the classified
        // failure means, from the same shared copy table as the error banner.
        <span className="vex-live-error">{view.errorBody}</span>
      ) : null}
      {view.state === "error" && view.errorDetail !== undefined ? (
        // Sanitized REAL cause (decree 2026-08-02) - technical register.
        <span className="vex-live-error__detail">{view.errorDetail}</span>
      ) : null}
      {view.state === "error" && preview.reasoningText.length > 0 ? (
        // The trace itself is deliberately NOT rendered on the error path.
        <span className="vex-live-error">Reasoning interrupted</span>
      ) : null}
    </div>
  );
}
