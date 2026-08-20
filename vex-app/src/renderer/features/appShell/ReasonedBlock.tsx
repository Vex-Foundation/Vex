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
 * REGISTER (owner decree 2026-07-30, "inna czcionka"): `.vex-reasoning-prose`
 * — Instrument Serif ITALIC, muted. Thinking aloud is not speaking, so it is
 * not set in the speaking face. The live island stream and the settled
 * in-turn stamps wear the identical class, so one trace looks the same
 * streaming, folded, and reopened a week later.
 */

import { useId, useState, type JSX } from "react";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import { IconChevronRight } from "../../components/icons/index.js";
import { cn } from "../../lib/utils.js";
import { reasonedStampLabel } from "./reasoning-stamp.js";

export function ReasonedBlock({
  reasoning,
  tokens = null,
  durationMs = null,
}: {
  /** Persisted trace; `null`/empty renders nothing at all. */
  readonly reasoning: string | null | undefined;
  /** Only when actually measured — omitted from the stamp otherwise. */
  readonly tokens?: number | null;
  readonly durationMs?: number | null;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  if (reasoning === null || reasoning === undefined || reasoning.length === 0) {
    return null;
  }

  return (
    <div data-vex-reasoning="persisted" className="mb-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-[4px] text-left font-serif text-[12px] italic text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-text-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
      >
        <IconChevronRight
          size={11}
          className={cn("shrink-0 transition-transform", open && "rotate-90")} />
        {reasonedStampLabel(tokens, durationMs)}
      </button>
      {open ? (
        <div
          id={bodyId}
          className="vex-reasoning-prose vex-entry-settle mt-1 break-words border-l border-[var(--vex-line)] pl-3 text-[14px] leading-[1.6]"
        >
          <MarkdownContent text={reasoning} />
        </div>
      ) : null}
    </div>
  );
}
