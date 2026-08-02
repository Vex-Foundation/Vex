/**
 * THE TURN ACTIVITY ISLAND — every move Vex makes in the current turn, in one
 * morphing surface above the streaming answer.
 *
 * DESIGN INTENT (owner visual round 2026-07-30: "obecny loading(thinking)
 * zaprojektować jakoś ciekawie"). The waiting moment is not dressed up with a
 * louder loader — it is filled with the only thing that is actually true, and
 * filled IMMEDIATELY: the island now mounts on the SEND, not on the first
 * provider delta, so the send can never read as a no-op. From there the turn
 * writes itself as a stack of thoughts — settled ones fold up into serif
 * stamps, the live one streams full-height beneath them — so waiting is spent
 * reading rather than watching a spinner. The single motion in the whole
 * surface is the cobalt shimmer sweeping the status word: the same mark the
 * VEX speaker caption wears, meaning the same thing in both places — Vex is
 * present. Everything else is stillness and the island's own shape morph, and
 * the shimmer stops dead under reduced motion and under the
 * awaiting-signature freeze, where motion would read as progress that is not
 * happening.
 *
 * States (derived purely in `islandTurnState.ts` from the `streamStore`
 * preview, never from timers):
 *
 *   Working   compact pill, the turn has begun and nothing is classified yet.
 *             This is the state the SEND opens on (`turnPreview.ts`)
 *   Thinking  the island EXPANDS and the full reasoning streams inside it as
 *             live markdown (`LiveReasoning`) under a "Thinking:" caption —
 *             no window, no clipping; unreadable is not a design
 *   Calling   a tool row: the protocol/tool mark (contract C5) + the tool name
 *   Writing   the island settles to the "Reasoned" stamp and the ANSWER
 *             streams below it, exactly as before
 *
 * Above every state except the hidden one, `ReasoningSegments` stacks the
 * thoughts this turn has already finished.
 *
 * Preserved from the working strip it replaces: the elapsed m:ss counter, the
 * awaiting-signature FREEZE (all motion stops, pin-tone label — trust equals
 * stillness), the visually-hidden `role="status"` announcements (phase + status
 * change a few times per turn; the growing text is never announced), and the
 * error branch, which shows a safe generic line and NEVER the trace.
 *
 * Removed with intent: the DotmCircular8/DotmHex3 gutter marks (dot-matrix
 * loaders elsewhere in the app are untouched) and the "Ephemeral — not
 * retained" label — reasoning is persisted now, so that label became a lie.
 *
 * Surface law: SOLID INK via the `dynamic-island` primitive — opaque
 * luminance and a hairline, never glass and never a resting glow;
 * `prefers-reduced-motion` is honored by the primitive.
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

const TONE_CLASS: Readonly<Record<TurnIslandView["tone"], string>> = {
  neutral: "text-[var(--vex-text-3)]",
  accent: "text-[var(--vex-accent-text)]",
  pin: "text-[var(--vex-pin)]",
  error: "text-destructive",
};

/**
 * THE STATUS WORD — and the island's only motion.
 *
 * While the turn is live the word wears `.vex-preview-shimmer`: a narrow
 * cobalt band sweeping through the glyphs on a slow 7s loop, the SAME
 * sanctioned gesture as the reasoning-effort selector's value and the VEX
 * speaker caption. One mark, one meaning — Vex is present and this is live.
 * It replaced a pulsing 2px bar that said the same thing in a third dialect.
 *
 * The base text stays SOLID at all times (the shimmer is an ::after duplicate
 * clipped to the glyphs, never a background-clip on the text itself), so under
 * `prefers-reduced-motion` — where the family drops the overlay entirely — and
 * under the awaiting-signature freeze, the word is simply still and fully
 * legible. `data-shimmer-text` must carry the identical string or the overlay
 * would sweep the wrong glyphs.
 */
function StatusWord({
  label,
  animated,
  className,
}: {
  readonly label: string;
  readonly animated: boolean;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      data-vex-island-label=""
      className={cn(animated && "vex-preview-shimmer", className)}
      data-shimmer-text={animated ? label : undefined}
    >
      {label}
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
      <DynamicContainer className="flex flex-col gap-1.5 px-3 py-2">
        <span className="flex items-baseline justify-between gap-2">
          {/* The caption reads "Thinking:" — a speaker label introducing the
              words below it, which is what the trace now is. The colon lives
              here and not in the view descriptor because the same label is
              announced to screen readers, where trailing punctuation is
              noise. */}
          <StatusWord
            label={`${view.label}:`}
            animated={view.animated}
            className={cn("font-serif text-[13px] italic", TONE_CLASS[view.tone])}
          />
          {view.showElapsed ? (
            <ElapsedCounter startedAtMs={preview.startedAtMs} />
          ) : null}
        </span>
        <LiveReasoning text={preview.reasoningText} live />
      </DynamicContainer>
    );
  }

  return (
    <DynamicContainer className="flex h-full w-full items-center gap-2 px-3 py-1.5">
      {view.state === "calling" && preview.toolName !== null ? (
        <CallingMark toolName={preview.toolName} />
      ) : null}
      <StatusWord
        label={view.label}
        animated={view.animated}
        className={cn("min-w-0 truncate text-[11px]", TONE_CLASS[view.tone])}
      />
      {view.showElapsed ? (
        <span className="ml-auto flex items-center">
          <ElapsedCounter startedAtMs={preview.startedAtMs} />
        </span>
      ) : null}
    </DynamicContainer>
  );
}

export function TurnIsland({
  preview,
  awaitingApproval = false,
}: {
  readonly preview: StreamPreview;
  /**
   * The active session has ≥1 pending approval. The island FREEZES: every
   * animation stops and the label becomes the pin-tone "Awaiting signature".
   * Derived upstream (SessionTranscript shares ApprovalsRegion's pending
   * query) so the stream store stays decoupled from TanStack Query.
   */
  readonly awaitingApproval?: boolean;
}): JSX.Element {
  const view = resolveTurnIslandView(preview, awaitingApproval);
  const streaming = preview.phase === "streaming";

  return (
    <div
      data-vex-island-state={view.state}
      data-vex-stream-awaiting={view.state === "awaiting" ? "" : undefined}
      className="flex flex-col"
    >
      {/* Announced: phase + status only. The growing text is NEVER a live
          region — that would spam a screen reader token by token; the
          persisted transcript row is the canonical content. */}
      <span className="sr-only" role="status">
        <span>
          {preview.phase === "error"
            ? "Vex stream error"
            : preview.phase === "done"
              ? "Vex responded"
              : "Vex is responding"}
        </span>
        {streaming ? <span>{view.label}</span> : null}
      </span>
      {/* The thoughts this turn has already finished, folded. They sit ABOVE
          the island because they are behind it in time — the turn reads top to
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
        <DynamicIsland id="vex-turn-island">
          <IslandBody view={view} preview={preview} />
        </DynamicIsland>
      </DynamicIslandProvider>
      {view.state === "error" && view.errorBody !== undefined ? (
        // Category copy, NOT provider text — the second line explains what the
        // classified failure means, from the same shared copy table as the
        // error banner.
        <span className="mt-1 text-xs text-destructive">{view.errorBody}</span>
      ) : null}
      {view.state === "error" && preview.reasoningText.length > 0 ? (
        // The trace itself is deliberately NOT rendered on the error path.
        <span className="mt-1 text-[11px] text-[var(--vex-text-3)]">
          Reasoning interrupted
        </span>
      ) : null}
    </div>
  );
}
