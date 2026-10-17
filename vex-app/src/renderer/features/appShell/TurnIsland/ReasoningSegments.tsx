/**
 * SETTLED THOUGHTS - the turn's finished reasoning segments, stacked above the
 * live row as quiet closed rows (30 high, 13 muted), each opening to the same
 * italic trace as a Reasoned row (docs/design/R3-MINIMAL.md section 6).
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
  LineChevronRight,
} from "../../../components/icons/line/index.js";
import { MarkdownContent } from "../../../lib/markdown/MarkdownContent.js";
import { ExpandRegion } from "../../../components/ui/expand-region.js";

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
          {label}
        </button>
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
