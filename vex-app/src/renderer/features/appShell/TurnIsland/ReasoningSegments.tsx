/**
 * SETTLED THOUGHTS - the turn's finished reasoning segments, as the step rows
 * of the live thinking frame (docs/design/H3-DESKTOP.md section 1.7: the
 * frame's MODEL rows under its THINKING head). Each is a ruled row, 36 high:
 * the small ink square, "Thought 1" in 14 ink, the chevron at the right; it
 * opens to the same trace as a Reasoned row. They sit under the frame's head
 * and above the live trace, in the order they were thought.
 *
 * A turn thinks, calls a tool, reads the result, and thinks again. Owner
 * decree 2026-07-30: each of those bursts is its own thought - "po zakończeniu
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

import { useId, useRef, useState, type JSX } from "react";
import {
  LineChevronDown,
  LineChevronUp,
} from "../../../components/icons/line/index.js";
import { MarkdownContent } from "../../../lib/markdown/MarkdownContent.js";
import { ExpandRegion } from "../../../components/ui/expand-region.js";
import { Swatch } from "../../../components/ui/swatch.js";

function SettledThought({
  text,
  label,
}: {
  readonly text: string;
  readonly label: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div data-vex-reasoning-segment="" className="vex-reasoned--quiet">
      <div className="vex-reasoned__row">
        {/* H3's step bullet: the small ink square of a finished MODEL row. */}
        <span aria-hidden className="vex-step__fill">
          <Swatch state="done" size={6} />
        </span>
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
        <span aria-hidden className="vex-step__spacer" />
        <span aria-hidden className="vex-reasoned__chev">
          {open ? <LineChevronUp size={14} /> : <LineChevronDown size={14} />}
        </span>
      </div>
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

export function ReasoningSegments({
  segments,
}: {
  readonly segments: readonly string[];
}): JSX.Element | null {
  if (segments.length === 0) return null;
  return (
    <div data-vex-reasoning-segments="" className="flex flex-col">
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
