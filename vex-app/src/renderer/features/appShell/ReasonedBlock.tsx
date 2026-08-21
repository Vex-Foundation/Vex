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
 * shared 3-frame visual throttle, and the row wears the running sweep. This is
 * live throughput WITHOUT exposing the chain of thought; expanding drops the
 * moving summary entirely so page reading never fights an internal follower.
 *
 * REGISTER (owner 6/6a, ratified 2026-08-21 - the serif leaves shell chrome).
 * The STAMP is deepseek's Think-row voice: the app sans at 13px/500 on the
 * label-secondary tier beside the existing chevron. The word stays "Reasoned";
 * only the face changed. The BODY is `.vex-reasoning-prose` (Inter Tight 14px,
 * muted) - thinking aloud is still not speaking, but the distance is carried
 * by tone and size rather than by a serif italic that cost legibility at
 * paragraph length. The live island stream and the settled in-turn stamps wear
 * the identical class, so one trace looks the same streaming, folded, and
 * reopened a week later.
 */

import { useEffect, useId, useRef, useState, type JSX } from "react";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import { IconChevronRight } from "../../components/icons/index.js";
import { cn } from "../../lib/utils.js";
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
      className="mb-1.5"
    >
      {/* Colour-only signals need a text equivalent: the sweep is decorative
          and the moving summary says nothing about state, so AT is told
          directly that this trace is still arriving. */}
      {running ? <span className="sr-only">Reasoning</span> : null}
      <div
        className="vex-row-sweep flex min-w-0 items-center"
        data-vex-sweep={running ? "running" : undefined}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex flex-none items-center gap-1 rounded-[4px] text-left text-[13px] font-medium text-ink-secondary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          <IconChevronRight
            size={11}
            className={cn("shrink-0 transition-transform", open && "rotate-90")} />
          {reasonedStampLabel(tokens, durationMs)}
        </button>
        {/* Expanding removes the moving summary: the full trace is right below
            in ordinary page flow, and page reading must never fight an
            internal follower. `text-clip` while following - an ellipsis at the
            end of a line that is being scrolled to its end is a lie about
            there being more. */}
        {!open ? (
          <>
            <span
              aria-hidden
              className="mx-2 h-[2px] w-[2px] flex-none rounded-[1px] bg-line-3"
            />
            <span
              ref={summaryRef}
              data-vex-reasoning-summary=""
              data-follow-end={running ? "true" : undefined}
              className={cn(
                "min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[12px] text-[var(--vex-text-3)]",
                running ? "text-clip" : "text-ellipsis",
              )}
            >
              {summary}
            </span>
          </>
        ) : null}
      </div>
      {open ? (
        <div
          id={bodyId}
          className="vex-reasoning-prose vex-entry-settle mt-1 break-words border-l border-[var(--vex-line)] pl-3 text-[14px] leading-[1.6]"
        >
          <MarkdownContent text={text} />
        </div>
      ) : null}
    </div>
  );
}
