/**
 * PERSISTED REASONING — the collapsible "Reasoned" block above an assistant
 * body (contract C1 `SessionMessageDto.reasoning`).
 *
 * Reasoning is no longer ephemeral: the engine persists it, so a settled turn
 * can be reopened days later. The block wears the SAME stamp the Turn Island
 * leaves behind when thinking ends (`reasoning-stamp.ts`), so the live→
 * persisted handover reads as one continuous object.
 *
 * `reasoning === null` — a non-assistant row, a legacy row written before the
 * engine persisted it, or a provider that emitted none — renders NOTHING. An
 * empty "Reasoned" affordance that opens onto nothing is a worse lie than an
 * absent one.
 *
 * The trace renders through `MarkdownContent` (safe React elements, never an
 * HTML string), collapsed by default so a long trace never buries the answer
 * it produced. Expanded shows the reasoning WHOLE — the cap is applied once,
 * by the engine, at write time; nothing is trimmed again for display.
 *
 * COLLAPSED SUMMARY (deepseek ReasoningRow). The collapsed row carries one
 * line of the trace beside the stamp: the LATEST non-blank line while the
 * block is the streaming tail, reverting to the FIRST line once settled. While
 * following, that one-line scrollport is pinned to its inline end through the
 * shared 3-frame visual throttle, and the row leads with the running node,
 * blinking (`data-vex-sweep` stays the running seam). This is
 * live throughput WITHOUT exposing the chain of thought; expanding drops the
 * moving summary entirely so page reading never fights an internal follower.
 *
 * REGISTER (docs/design/H3-DESKTOP.md section 1.7 and Appendix A.7). H3's
 * thinking row: a framed cell, 40 high, the dot-grid glyph, the label in caps
 * 13 tracked ink, the one-line summary in 13 muted, then at the right the
 * turn's step count in 13 muted and the chevron. The whole row is the key.
 * Opened, the trace is upright 14 ink 2 under the row's rule, inside the
 * same frame (`.vex-reasoned__body`). The live row's trace and the settled
 * in-turn thoughts wear the identical body class, so one trace looks the
 * same streaming, folded, and reopened a week later.
 *
 * THE TURN'S HEAD. The first Reasoned row of a turn is the turn's thinking
 * row (`SessionTranscript/turnSteps.ts`), so it also says the turn's steps
 * ("3 steps") and, after a turn watched live, how long the turn took ("Thought
 * for 2.8 s", the live turn clock's own reading, `TurnIsland/turnClock.ts`).
 * A turn reopened from history has no stored duration, so it says "Reasoned"
 * and its steps only. Every other Reasoned row of the turn says "Reasoned".
 */

import { useEffect, useId, useRef, useState, type JSX } from "react";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import {
  LineChevronDown,
  LineChevronUp,
} from "../../components/icons/line/index.js";
import { cn } from "../../lib/utils.js";
import { ExpandRegion } from "../../components/ui/expand-region.js";
import { useThrottledVisualUpdate } from "../../lib/use-throttled-visual-update.js";
import { reasonedStampLabel, stepsLabel } from "./reasoning-stamp.js";
import { StepNode } from "./ToolLedger/StepNode.js";
import { formatToolDuration } from "./ToolLedger/toolDuration.js";

/**
 * H3's thinking glyph: the three-by-three dot grid it draws before THINKING
 * and THOUGHT FOR (the same glyph as the Send key's). Decorative; drawn in the
 * row's current colour.
 */
export function ThinkGlyph(): JSX.Element {
  const cells: JSX.Element[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      cells.push(
        <rect key={`${row}-${col}`} x={col * 4} y={row * 4} width="2" height="2" />,
      );
    }
  }
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 10 10"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-vex-think-glyph=""
    >
      {cells}
    </svg>
  );
}

/** The trace's opening line - the stable summary of a settled block. */
function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/**
 * The newest non-blank line - the live summary while the block is the
 * streaming tail. Trailing whitespace is dropped first so a delta that ends in
 * a newline does not momentarily blank the summary.
 */
function latestLine(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf("\n");
  return newline === -1 ? visible : visible.slice(newline + 1);
}

export function ReasonedBlock({
  reasoning,
  tokens = null,
  durationMs = null,
  running = false,
  steps = null,
  thoughtMs = null,
}: {
  /** Persisted trace; `null`/empty renders nothing at all. */
  readonly reasoning: string | null | undefined;
  /** Only when actually measured — omitted from the stamp otherwise. */
  readonly tokens?: number | null;
  readonly durationMs?: number | null;
  /**
   * This block is the turn's STREAMING tail: the collapsed summary follows the
   * latest line to its inline end and the row wears the running sweep. Settled
   * blocks (every persisted transcript row) leave it false.
   */
  readonly running?: boolean;
  /**
   * The whole turn's steps, set only on the turn's thinking row
   * (`turnSteps.ts`); `null` draws no count.
   */
  readonly steps?: number | null;
  /**
   * The live turn clock's reading for this turn (`turnClock.ts`), set only
   * on the turn's thinking row after a turn watched live; `null` keeps
   * "Reasoned".
   */
  readonly thoughtMs?: number | null;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLSpanElement>(null);
  const text = reasoning ?? "";
  const summary = running ? latestLine(text) : firstLine(text);

  // ONE-LINE FOLLOWER (deepseek ReasoningRow). Live throughput is visible
  // without expanding the chain of thought: the summary's own scrollport is
  // pinned to its inline end while deltas arrive and released on settle.
  // Scheduled through the shared 3-frame throttle so a token-rate stream costs
  // at most one layout read per three frames, and cancelled on unmount.
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current;
    if (element === null) return;
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0;
  });
  useEffect(() => {
    scheduleSummaryScroll();
  }, [running, scheduleSummaryScroll, summary]);

  if (text.length === 0) return null;

  // "Thought for 2.8 s" (docs/design/H3-DESKTOP.md Appendix A.7): the live
  // turn clock's own measurement, spelled as the step rows spell their
  // measured times ("812 ms", "2.8 s", "1m 05s"). The words are a label
  // (caps); the figure keeps its own case, as H3 prints "THOUGHT FOR 2.8s".
  // No measurement keeps "Reasoned": nothing is ever estimated.
  const thoughtFor = formatToolDuration(thoughtMs);
  const label =
    thoughtFor === null ? (
      reasonedStampLabel(tokens, durationMs)
    ) : (
      <>
        Thought for <span className="vex-reasoned__figure">{thoughtFor}</span>
      </>
    );
  const count = stepsLabel(steps);

  return (
    <div
      data-vex-reasoning="persisted"
      data-vex-reasoning-state={running ? "running" : "settled"}
      data-vex-thinking-head={steps !== null ? "" : undefined}
      className="vex-think"
    >
      {/* Fill-only signals need a text equivalent: the swatch is decorative
          and the moving summary says nothing about state, so AT is told
          directly that this trace is still arriving. */}
      {running ? <span className="sr-only">Reasoning</span> : null}
      <div
        className="vex-reasoned__row"
        data-vex-sweep={running ? "running" : undefined}
      >
        {/* The glyph: the running node while the trace streams, blinking
            (PD-06), H3's dot grid once it has settled. */}
        <span aria-hidden className="vex-step__fill">
          {running ? <StepNode state="running" /> : <ThinkGlyph />}
        </span>
        {/* The key is the label; its hit area stretches over the whole row
            (`.vex-reasoned__key::after`), so the row opens wherever it is
            pressed while its accessible name stays the label alone. */}
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="vex-reasoned__key"
        >
          {label}
        </button>
        {/* Expanding removes the moving summary: the full trace is right below
            in ordinary page flow, and page reading must never fight an
            internal follower. `text-clip` while following - an ellipsis at the
            end of a line that is being scrolled to its end is a lie about
            there being more. */}
        {!open ? (
          <span
            ref={summaryRef}
            data-vex-reasoning-summary=""
            data-follow-end={running ? "true" : undefined}
            className={cn(
              "vex-reasoned__summary",
              running ? "text-clip" : "text-ellipsis",
            )}
          >
            {summary}
          </span>
        ) : (
          <span aria-hidden className="vex-step__spacer" />
        )}
        {count !== null ? (
          <span data-vex-turn-steps="" className="vex-reasoned__steps">
            {count}
          </span>
        ) : null}
        <span aria-hidden className="vex-reasoned__chev">
          {open ? <LineChevronUp size={14} /> : <LineChevronDown size={14} />}
        </span>
      </div>
      {/* The trace rides the shared expand primitive: it stays mounted once
          opened so closing animates, and carries no entrance keyframe - an
          expanding reveal must not also play a mount animation. */}
      <ExpandRegion
        id={bodyId}
        open={open}
        triggerRef={triggerRef}
        className="vex-reasoning-prose vex-reasoned__body break-words"
      >
        <MarkdownContent text={text} />
      </ExpandRegion>
    </div>
  );
}
