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
 * shared 3-frame visual throttle, and the row leads with the thinking fill
 * (status by fill; `data-vex-sweep` stays the running seam). This is
 * live throughput WITHOUT exposing the chain of thought; expanding drops the
 * moving summary entirely so page reading never fights an internal follower.
 *
 * REGISTER (docs/design/R3-MINIMAL.md section 6). "Reasoned" is a closed row,
 * 36 high: the chevron and the word in 14 ink 2 at 400, the summary in 13
 * muted. Opened, the trace is italic 14 ink 2 on a 1px rule with 12 clear
 * (`.vex-reasoned__body`). The live row's trace and the settled in-turn
 * thoughts wear the identical classes, so one trace looks the same streaming,
 * folded, and reopened a week later.
 */

import { useEffect, useId, useRef, useState, type JSX } from "react";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import {
  LineChevronDown,
  LineChevronRight,
} from "../../components/icons/line/index.js";
import { cn } from "../../lib/utils.js";
import { ExpandRegion } from "../../components/ui/expand-region.js";
import { Swatch } from "../../components/ui/swatch.js";
import { useThrottledVisualUpdate } from "../../lib/use-throttled-visual-update.js";
import { reasonedStampLabel } from "./reasoning-stamp.js";

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

  return (
    <div
      data-vex-reasoning="persisted"
      data-vex-reasoning-state={running ? "running" : "settled"}
    >
      {/* Fill-only signals need a text equivalent: the swatch is decorative
          and the moving summary says nothing about state, so AT is told
          directly that this trace is still arriving. */}
      {running ? <span className="sr-only">Reasoning</span> : null}
      <div
        className="vex-reasoned__row"
        data-vex-sweep={running ? "running" : undefined}
      >
        {running ? (
          <span aria-hidden className="vex-step__fill">
            <Swatch state="thinking" size={10} />
          </span>
        ) : null}
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="vex-reasoned__key"
        >
          {open ? (
            <LineChevronDown size={14} className="shrink-0" />
          ) : (
            <LineChevronRight size={14} className="shrink-0" />
          )}
          {reasonedStampLabel(tokens, durationMs)}
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
        ) : null}
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
