/**
 * THE TURN ACTIVITY ISLAND — every move Vex makes in the current turn, in one
 * morphing surface above the streaming answer.
 *
 * DESIGN INTENT (owner visual round 2026-07-30: "obecny loading(thinking)
 * zaprojektować jakoś ciekawie"). The waiting moment is not dressed up with a
 * louder loader — it is filled with the only thing that is actually true, and
 * filled IMMEDIATELY: the island now mounts on the SEND, not on the first
 * provider delta, so the send can never read as a no-op. From there the turn
 * writes itself as a stack of thoughts - settled ones fold up into stamps, the
 * live one streams full-height beneath them - so waiting is spent reading
 * rather than watching a spinner. The single motion in the whole surface is
 * the ONGOING SWATCH before the status word (docs/design/V10-SPREAD.md
 * section 1: status by fill, the dot screen stepping through four positions):
 * the same mark the run band and the agent's mark wear, meaning the same thing
 * everywhere - Vex is working. Everything else is stillness and the island's
 * own shape morph; the swatch stills under reduced motion, and under the
 * awaiting-signature freeze it becomes the target, where motion would read as
 * progress that is not happening.
 *
 * States (derived purely in `islandTurnState.ts` from the `streamStore`
 * preview, never from timers):
 *
 *   Working   compact pill, the turn has begun and nothing is classified yet.
 *             This is the state the SEND opens on (`turnPreview.ts`). A caption
 *             beneath says "Preparing the turn" until the engine reports the
 *             lease, then "Waiting for the model"
 *   Thinking  the island EXPANDS and the full reasoning streams inside it as
 *             live markdown (`LiveReasoning`) under a "Thinking:" caption —
 *             no window, no clipping; unreadable is not a design
 *   Calling   a tool row: the protocol/tool mark (contract C5) + the tool name
 *   Running   the same row once the provider stream has ended and the tool
 *             is executing ("Running {tool}"), until its round persists
 *   Writing   the island settles to the "Reasoned" stamp and the ANSWER
 *             streams below it, exactly as before
 *
 * Above every state except the hidden one, `ReasoningSegments` stacks the
 * thoughts this turn has already finished.
 *
 * Preserved from the working strip it replaces: the elapsed m:ss counter (in
 * Departure Mono, never the italic serif), the awaiting-signature FREEZE (all
 * motion stops, the target swatch on the blue line - trust equals stillness),
 * the visually-hidden `role="status"` announcements (phase + status
 * change a few times per turn; the growing text is never announced), and the
 * error branch, which shows a safe generic line and NEVER the trace.
 *
 * Removed with intent: the DotmCircular8/DotmHex3 gutter marks (dot-matrix
 * loaders elsewhere in the app are untouched) and the "Ephemeral — not
 * retained" label — reasoning is persisted now, so that label became a lie.
 *
 * Surface law (reference d3): a ruled box on the page's paper via the
 * `dynamic-island` primitive (`.vex-island`, chat-transcript.css), never glass
 * and never a resting glow; `prefers-reduced-motion` is honored by the
 * primitive. `data-vex-island-state` is the test seam.
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
 * The word's ink per tone. The live and attention words speak in the blue
 * (reference d3: the island's caption is the blue), a settled stamp in the
 * second ink, an error in ink - never red.
 */
const TONE_CLASS: Readonly<Record<TurnIslandView["tone"], string>> = {
  neutral: "text-ink-secondary",
  accent: "text-accent-primary",
  pin: "text-accent-primary",
  error: "text-ink-primary",
};

/**
 * The fill before the word - status by fill, and the island's only motion.
 * Live work is the ongoing dot screen (it steps; `marks.css` stills it under
 * reduced motion); the awaiting freeze is the target, and it never moves; an
 * error is the ink cross; a settled stamp is the solid square.
 */
function islandSwatch(view: TurnIslandView): SwatchState {
  if (view.state === "error") return "error";
  if (view.state === "awaiting") return "warning";
  if (view.state === "settled") return "done";
  return view.animated ? "ongoing" : "done";
}

/**
 * THE STATUS WORD: 11px Departure Mono caps at the status tracking, behind
 * its swatch. The swatch carries the state; the word repeats it.
 */
function StatusWord({
  label,
  view,
  className,
}: {
  readonly label: string;
  readonly view: TurnIslandView;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-[9px] font-mono text-[11px] uppercase leading-none tracking-status",
        TONE_CLASS[view.tone],
        className,
      )}
    >
      <span aria-hidden className="inline-flex flex-none text-accent-primary">
        <Swatch state={islandSwatch(view)} size={9} />
      </span>
      <span data-vex-island-label="" className="min-w-0 truncate">
        {label}
      </span>
    </span>
  );
}

/** The elapsed clock: Departure Mono 11px on the second ink, tabular. */
function IslandClock({ startedAtMs }: { readonly startedAtMs: number }): JSX.Element {
  return (
    <span data-vex-island-clock="" className="flex flex-none items-center">
      <ElapsedCounter startedAtMs={startedAtMs} />
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

  if (view.state === "thinking") {
    return (
      <DynamicContainer className="flex flex-col gap-1.5 px-3.5 pb-3 pt-2.5">
        <span className="flex items-center justify-between gap-2">
          {/* The caption reads "Thinking:" — a speaker label introducing the
              words below it, which is what the trace now is. The colon lives
              here and not in the view descriptor because the same label is
              announced to screen readers, where trailing punctuation is
              noise. */}
          <StatusWord label={`${view.label}:`} view={view} />
          {view.showElapsed ? (
            <IslandClock startedAtMs={preview.startedAtMs} />
          ) : null}
        </span>
        <LiveReasoning text={preview.reasoningText} />
      </DynamicContainer>
    );
  }

  return (
    <DynamicContainer className="flex h-full w-full items-center gap-2.5 px-3.5">
      {(view.state === "calling" || view.state === "running")
      && preview.toolName !== null ? (
        <span className="inline-flex flex-none text-accent-primary">
          <CallingMark toolName={preview.toolName} />
        </span>
      ) : null}
      <StatusWord label={view.label} view={view} />
      {view.showElapsed ? (
        <span className="ml-auto flex">
          <IslandClock startedAtMs={preview.startedAtMs} />
        </span>
      ) : null}
    </DynamicContainer>
  );
}

export function TurnIsland({
  preview,
  awaitingApproval = false,
  leaseHeld = false,
}: {
  readonly preview: StreamPreview;
  /**
   * The active session has ≥1 pending approval. The island FREEZES: every
   * animation stops and the label becomes "Awaiting signature" behind the
   * target swatch, on the blue line.
   * Derived upstream (SessionTranscript shares ApprovalsRegion's pending
   * query) so the stream store stays decoupled from TanStack Query.
   */
  readonly awaitingApproval?: boolean;
  /**
   * The engine reported the session's runner lease as held (control-state
   * push). Splits the compact pill's caption into "Preparing the turn" and
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
          the island because they are behind it in time - the turn reads top to
          bottom as it happened. They persist across tool calls and across
          provider rounds; only the end of the TURN retires them. */}
      <ReasoningSegments segments={preview.reasoningSegments} />
      {/* THE FREEZE reaches the SHELL, not just the status word: while a
          signature is pending the island's shape morph and every content
          cross-fade become hard cuts, so the surface goes genuinely still
          instead of springing into the awaiting state. */}
      <DynamicIslandProvider
        initialSize={view.size}
        frozen={view.state === "awaiting"}
      >
        {/* `data-vex-sweep` marks the live tool row (the seam the running
            row has always carried); the swatch inside is its only motion. */}
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
      {view.detail !== undefined ? (
        // WHICH PART OF THE WAIT (U-3). Beneath the pill, never inside it: the
        // pill keeps its one word and its fixed width. Fixed copy only, and
        // aria-hidden because the status region above already announces it.
        <span
          aria-hidden="true"
          data-vex-island-detail=""
          className="mt-1.5 font-mono text-[11px] uppercase tracking-status text-ink-secondary"
        >
          {view.detail}
        </span>
      ) : null}
      {view.state === "error" && view.errorBody !== undefined ? (
        // Category copy - the second line explains what the classified
        // failure means, from the same shared copy table as the error banner.
        <span className="mt-1.5 text-[13px] leading-5 text-ink-primary">{view.errorBody}</span>
      ) : null}
      {view.state === "error" && view.errorDetail !== undefined ? (
        // Sanitized REAL cause (decree 2026-08-02) - technical register.
        <span className="mt-1 break-words font-code text-[11.5px] leading-4 text-ink-secondary">
          {view.errorDetail}
        </span>
      ) : null}
      {view.state === "error" && preview.reasoningText.length > 0 ? (
        // The trace itself is deliberately NOT rendered on the error path.
        <span className="mt-1 font-mono text-[11px] uppercase tracking-status text-ink-secondary">
          Reasoning interrupted
        </span>
      ) : null}
    </div>
  );
}
