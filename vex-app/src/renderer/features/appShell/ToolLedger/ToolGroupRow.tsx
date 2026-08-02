/**
 * THE ACT LEDGER — aggregation entry (S5). A run of ≥3 registered calls
 * collapses into one ledger line: "{N} tool calls" plus a strip of distinct
 * act glyphs. Expanding reveals the member `ToolActRow`s under an indented
 * rail. Reveal strategy: simple conditional render with `.vex-entry-settle`
 * on each member — chosen over the grid-rows 0fr→1fr trick because it needs
 * no measured heights, the 180ms settle sits inside the 160–200ms law, and
 * the global reduced-motion rule collapses it to a hard cut for free.
 *
 * The group surfaces "Awaiting signature" at header level when ANY member
 * matches a pending approval, so a collapsed group can never hide the one
 * thing waiting on the user's pen.
 */

import { useId, useState, type JSX } from "react";
import {
  ArrowRight01Icon,
  type IconGlyph,
  VexIcon,
} from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";
import type { ToolGroupRowModel } from "../transcriptRowModel.js";
import { ApprovalLinkStamp } from "./ApprovalLinkStamp.js";
import { ToolActRow } from "./ToolActRow.js";
import { toolGlyph } from "./toolGlyph.js";

/** Show at most this many distinct glyphs; the rest become "+{k}". */
const MAX_HEADER_GLYPHS = 4;

/**
 * Distinct glyphs (by icon identity, not tool name) — two tools sharing a
 * category must not print the same glyph twice in the header strip.
 */
function distinctGlyphs(toolNames: readonly string[]): IconGlyph[] {
  const glyphs: IconGlyph[] = [];
  for (const name of toolNames) {
    const glyph = toolGlyph(name);
    if (!glyphs.includes(glyph)) glyphs.push(glyph);
  }
  return glyphs;
}

export function ToolGroupRow({
  group,
  pendingApprovals,
}: {
  readonly group: ToolGroupRowModel;
  /** toolCallId → PENDING approval id for the active session (S5). */
  readonly pendingApprovals?: ReadonlyMap<string, string>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const glyphs = distinctGlyphs(group.distinctToolNames);
  const overflow = glyphs.length - MAX_HEADER_GLYPHS;
  // First matched member carries the group-level stamp target.
  const matchedApprovalId =
    pendingApprovals === undefined
      ? null
      : (group.calls
          .map((call) => pendingApprovals.get(call.toolCallId))
          .find((id) => id !== undefined) ?? null);
  return (
    <div
      // Semantic contract: the group container is a tool row too.
      data-vex-message-role="tool"
      className="rounded-[6px] border border-[var(--vex-line)] bg-white/[0.02]"
    >
      <div className="flex h-10 items-center gap-2 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          <VexIcon
            icon={ArrowRight01Icon}
            size={12}
            aria-hidden
            className={cn(
              "shrink-0 text-[var(--vex-text-3)] transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="shrink-0 font-mono text-[12px] tabular-nums text-foreground">
            {group.calls.length} tool calls
          </span>
          <span aria-hidden className="flex min-w-0 items-center gap-1.5">
            {glyphs.slice(0, MAX_HEADER_GLYPHS).map((glyph, index) => (
              <VexIcon
                // Icon identity is the dedupe key; index keeps React stable.
                key={index}
                icon={glyph}
                size={14}
                className="shrink-0 text-[var(--vex-text-3)]"
              />
            ))}
            {overflow > 0 ? (
              <span className="font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
                +{overflow}
              </span>
            ) : null}
          </span>
        </button>
        {matchedApprovalId !== null ? (
          <ApprovalLinkStamp approvalId={matchedApprovalId} />
        ) : null}
      </div>
      {open ? (
        <div id={bodyId} className="border-t border-[var(--vex-line)] px-2 py-2">
          {/* Indented rail — member acts hang off the group's spine. */}
          <div className="ml-1.5 flex flex-col gap-1.5 border-l border-[var(--vex-line)] pl-6">
            {group.calls.map((call) => (
              <div key={call.toolCallId} className="vex-entry-settle">
                <ToolActRow
                  act={call}
                  pendingApprovalId={
                    pendingApprovals?.get(call.toolCallId) ?? null
                  }
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
