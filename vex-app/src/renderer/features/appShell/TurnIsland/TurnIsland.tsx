/**
 * THE TURN ACTIVITY ISLAND — every move Vex makes in the current turn, in one
 * morphing surface above the streaming answer.
 *
 * States (derived purely in `islandTurnState.ts` from the `streamStore`
 * preview, never from timers):
 *
 *   Working   compact pill, the turn has begun and nothing is classified yet
 *   Thinking  the island EXPANDS and the full reasoning streams inside it as
 *             live markdown (`LiveReasoning`) — the old 46px masked peek is
 *             gone; unreadable is not a design
 *   Calling   a tool row: the protocol/tool mark (contract C5) + the tool name
 *             + a loading treatment
 *   Writing   the island settles to the "Reasoned" stamp and the ANSWER
 *             streams below it, exactly as before
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
 * The "still working" cue while a tool runs. A 2px bar that breathes in
 * opacity only — killed outright by the freeze and by reduced motion (the
 * global `motion-reduce` rule), so it can only ever mean live work.
 */
function LoadingBar({ animated }: { readonly animated: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        "h-[2px] w-8 shrink-0 rounded-full bg-[var(--vex-accent)]",
        animated && "animate-pulse motion-reduce:animate-none",
      )}
    />
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
          <span className={cn("text-[11px]", TONE_CLASS[view.tone])}>
            {view.label}
          </span>
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
      <span
        data-vex-island-label=""
        className={cn("min-w-0 truncate text-[11px]", TONE_CLASS[view.tone])}
      >
        {view.label}
      </span>
      {view.state === "calling" ? <LoadingBar animated={view.animated} /> : null}
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
      <DynamicIslandProvider initialSize={view.size}>
        <DynamicIsland id="vex-turn-island">
          <IslandBody view={view} preview={preview} />
        </DynamicIsland>
      </DynamicIslandProvider>
      {view.state === "error" && preview.reasoningText.length > 0 ? (
        // The trace itself is deliberately NOT rendered on the error path.
        <span className="mt-1 text-[11px] text-[var(--vex-text-3)]">
          Reasoning interrupted
        </span>
      ) : null}
    </div>
  );
}
