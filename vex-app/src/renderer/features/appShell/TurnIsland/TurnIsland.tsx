/**
 * THE TURN'S LIVE FRAME - every move Vex makes in the current turn, as H3's
 * thinking frame at the tail of the transcript (docs/design/H3-DESKTOP.md
 * section 1.7: "Vex's thinking is a framed row").
 *
 * DESIGN INTENT. The waiting moment is not dressed up with a louder loader -
 * it is filled with the only thing that is actually true, and filled
 * IMMEDIATELY: the frame mounts on the SEND, not on the first provider delta,
 * so the send can never read as a no-op. Its head always carries a node, a
 * word and a timer: the node (every live state the running node, blinking
 * beside the live timer; waiting the target), the state word in caps 13 tracked ink ("THINKING"), its scope in
 * 13 muted, the real elapsed time in the mono 12 muted at the right. Under the
 * head, in the order they happened, the thoughts the turn has finished as
 * step rows, then the live one streaming in full, so waiting is spent reading
 * rather than watching a spinner. When the turn settles, the frame hands its
 * clock's reading up once (`useSettledTurnClock`), and the turn's persisted
 * thinking row reads it as "Thought for 2.8 s" (`turnClock.ts`).
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
 *             as its scope ("Thought · 1.2K tokens")
 *
 * Preserved from the working strip it replaces: the elapsed m:ss counter, the
 * awaiting-approval FREEZE (all motion stops, the target - trust equals
 * stillness), the visually-hidden `role="status"` announcements (phase +
 * status change a few times per turn; the growing text is never announced),
 * and the error branch, which shows a safe generic line and NEVER the trace.
 *
 * Surface law: a square cell on the ground framed by the 1px rule, no fill,
 * no glass, no glow (`.vex-island` and `.vex-live-row`, chat-transcript.css,
 * on the `dynamic-island` primitive, whose shape stays one live-row size so it
 * never morphs). `prefers-reduced-motion` is honored by the primitive.
 * `data-vex-island-state` is the test seam.
 */

import { useEffect, useRef, type JSX } from "react";
import {
  DynamicContainer,
  DynamicIsland,
  DynamicIslandProvider,
  useIslandSizeSync,
} from "../../../components/ui/dynamic-island.js";
import type { StreamPreview } from "../../../stores/streamStore.js";
import { cn } from "../../../lib/utils.js";
import { StepNode, type StepNodeState } from "../ToolLedger/StepNode.js";
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
 * The node before the word: the trace's running step (docs/design/
 * H3-DESKTOP.md sections 1.7 and 2.2; VEX Cloud's trace). Every live state
 * (working, thinking, calling a tool, running it, writing) is the running
 * node, which blinks beside the live timer (PD-06); the awaiting freeze is
 * the target, still (trust is stillness); an error the ink cross; a settled
 * row the done node.
 */
export function islandNode(view: TurnIslandView): StepNodeState {
  if (view.state === "error") return "failed";
  if (view.state === "awaiting") return "waiting";
  if (view.state === "settled") return "done";
  return "running";
}

/** The node that leads the live row; the word after it repeats the state. */
function StatusFill({ view }: { readonly view: TurnIslandView }): JSX.Element {
  return (
    <span aria-hidden className="vex-step__fill">
      <StepNode state={islandNode(view)} />
    </span>
  );
}

/**
 * THE WORD behind its fill: the frame head's label, caps 13 tracked in ink
 * (`.vex-live-row .vex-step__title`).
 */
function StatusWord({ label }: { readonly label: string }): JSX.Element {
  return (
    <span data-vex-island-label="" className="vex-step__title">
      {label}
    </span>
  );
}

/** The elapsed clock: the mono 12, tabular, muted, at the head's right. */
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
      data-vex-island-head=""
      className={cn(
        "vex-step vex-live-row",
        view.state === "settled" && "vex-live-row--settled",
      )}
    >
      <StatusFill view={view} />
      {(view.state === "calling" || view.state === "running")
      && preview.toolName !== null ? (
        <span className="vex-step__mark">
          <CallingMark toolName={preview.toolName} />
        </span>
      ) : null}
      {/* The frame's head reads the state word in caps, "THINKING" as H3
          draws it, with the words it introduces streaming below the rule. */}
      <StatusWord label={view.label} />
      <IslandScope detail={view.detail} />
      <span aria-hidden className="vex-step__spacer" />
      {view.showElapsed ? <IslandClock startedAtMs={preview.startedAtMs} /> : null}
    </span>
  );

  // ONE container for every state, its children in fixed positions (the
  // head, the settled thoughts, the live trace), so React keeps the thought
  // rows mounted, and an opened one stays open, as the turn moves from
  // thinking to calling a tool and back.
  return (
    <DynamicContainer className="flex w-full flex-col">
      {row}
      <ReasoningSegments segments={preview.reasoningSegments} />
      {view.state === "thinking" ? <LiveReasoning text={preview.reasoningText} /> : null}
    </DynamicContainer>
  );
}

/**
 * The live turn clock's reading at the frame the turn settled, handed up once
 * per turn (`turnClock.ts`): the elapsed time of the same clock the head row
 * showed, from the turn's start (the send) to Vex's finished answer.
 *
 * It reports NOTHING for a turn that waited on the person: the clock keeps
 * running under "Waiting for approval", so its reading would count the
 * reader's decision as Vex's thinking. Nor for a turn that errored or was
 * stopped (neither ever settles here: both are cleared on their own delta).
 *
 * The start is the EARLIEST the row saw for this turn: `useTurnPreview` pins
 * it to the send while `chat.submit` is pending, and once the mutation
 * settles the store's own start (the first delta, later) shows through; the
 * earlier one is the turn the reader watched.
 */
function useSettledTurnClock(
  view: TurnIslandView,
  startedAtMs: number,
  onSettled: ((thoughtMs: number, startedAtMs: number) => void) | undefined,
): void {
  const turn = useRef<{ start: number; awaited: boolean; reported: boolean } | null>(null);
  const live = view.state !== "settled" && view.state !== "error";
  // Render-time bookkeeping, the transcript's own idiom (`turnPreview.ts`):
  // the start must be right on the very render the turn settles in.
  if (turn.current === null || (live && turn.current.reported)) {
    turn.current = { start: startedAtMs, awaited: false, reported: false };
  } else if (startedAtMs < turn.current.start) {
    turn.current.start = startedAtMs;
  }
  if (view.state === "awaiting") turn.current.awaited = true;
  const settled = view.state === "settled";
  useEffect(() => {
    const current = turn.current;
    if (!settled || current === null || current.reported) return;
    current.reported = true;
    if (current.awaited || onSettled === undefined) return;
    onSettled(Date.now() - current.start, current.start);
  }, [settled, onSettled]);
}

export function TurnIsland({
  preview,
  awaitingApproval = false,
  leaseHeld = false,
  onSettled,
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
  /**
   * The turn settled: its live clock's reading, once, and the start it was
   * measured from (`useSettledTurnClock`). Omitted = nobody keeps it.
   */
  readonly onSettled?: (thoughtMs: number, startedAtMs: number) => void;
}): JSX.Element {
  const view = resolveTurnIslandView(preview, awaitingApproval, leaseHeld);
  useSettledTurnClock(view, preview.startedAtMs, onSettled);
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
