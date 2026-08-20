/**
 * SETTLED THOUGHTS — the turn's finished reasoning segments, stacked above the
 * live island as collapsed stamps.
 *
 * A turn thinks, calls a tool, reads the result, and thinks again. Owner
 * decree 2026-07-30: each of those bursts is its own thought — "po zakończeniu
 * lub wywołaniu toola zwija się do rozwinięcia; po toolu znowu Thinking:".
 * `streamStore` closes a segment on every `tool_call` delta and on every round
 * boundary, so the list here is exactly the sequence of thoughts the turn has
 * finished having.
 *
 * The ordinal is not decoration: it is the only thing distinguishing one
 * folded thought from the next, and the ORDER carries real information (what
 * Vex thought before the swap quote came back versus after it). A single
 * thought needs no number and does not get one.
 *
 * Expanded shows the segment WHOLE — the cap is applied once, upstream, at
 * 16 384 chars per segment; nothing is trimmed again for display.
 */

import { useState, type JSX } from "react";
import { IconChevronRight } from "../../../components/icons/index.js";
import { MarkdownContent } from "../../../lib/markdown/MarkdownContent.js";
import { cn } from "../../../lib/utils.js";

function SettledThought({
  text,
  label,
}: {
  readonly text: string;
  readonly label: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div data-vex-reasoning-segment="">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-[4px] text-left font-serif text-[12px] italic text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-text-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
      >
        <IconChevronRight
          size={11}
          className={cn("shrink-0 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open ? (
        <div className="vex-reasoning-prose vex-entry-settle mt-1 break-words border-l border-[var(--vex-line)] pl-3 text-[14px] leading-[1.6]">
          <MarkdownContent text={text} />
        </div>
      ) : null}
    </div>
  );
}

export function ReasoningSegments({
  segments,
}: {
  readonly segments: readonly string[];
}): JSX.Element | null {
  if (segments.length === 0) return null;
  return (
    <div data-vex-reasoning-segments="" className="mb-1.5 flex flex-col gap-1">
      {segments.map((text, index) => (
        // Index keys are correct here: this is an append-only ordered
        // projection of the turn's history — never reordered, never spliced.
        <SettledThought
          key={index}
          text={text}
          label={segments.length === 1 ? "Thought" : `Thought ${index + 1}`}
        />
      ))}
    </div>
  );
}
