/**
 * THE ACT LEDGER — aggregation entry (S5). A run of ≥3 registered calls
 * collapses into one ledger line: "{N} tool calls" plus a strip of distinct
 * act glyphs. Expanding reveals the member `ToolActRow`s under an indented
 * rail. The reveal is the shared `ExpandRegion` primitive (one curve, one
 * duration, one closed-content contract app-wide); the members carry no
 * entrance keyframe of their own, since the expand IS the arrival.
 *
 * The group surfaces "Awaiting signature" at header level when ANY member
 * matches a pending approval, so a collapsed group can never hide the one
 * thing waiting on the user's pen.
 */

import { useId, useRef, useState, type ComponentType, type JSX } from "react";
import {
  IconChevronRight,
  type GlyphProps,
} from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";
import { ExpandRegion } from "../../../components/ui/expand-region.js";
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
function distinctGlyphs(
  toolNames: readonly string[],
): ComponentType<GlyphProps>[] {
  const glyphs: ComponentType<GlyphProps>[] = [];
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
  const triggerRef = useRef<HTMLButtonElement>(null);
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
      className="rounded-[6px] border border-[var(--vex-line)] bg-interactive-hover"
    >
      <div className="flex h-10 items-center gap-2 pr-2">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          <IconChevronRight
            size={12}
            className={cn(
              "shrink-0 text-[var(--vex-text-3)] transition-transform",
              open && "rotate-90",
            )} />
          <span className="shrink-0 font-mono text-[12px] tabular-nums text-foreground">
            {group.calls.length} tool calls
          </span>
          <span aria-hidden className="flex min-w-0 items-center gap-1.5">
            {glyphs.slice(0, MAX_HEADER_GLYPHS).map((Glyph, index) => (
              // Icon identity is the dedupe key; index keeps React stable.
              <Glyph
                key={index}
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
      <ExpandRegion
        id={bodyId}
        open={open}
        triggerRef={triggerRef}
        className="border-t border-[var(--vex-line)] px-2 py-2"
      >
        {/* Indented rail — member acts hang off the group's spine. The rows
            carry no entrance keyframe: the reveal is the expand itself. */}
        <div className="ml-1.5 flex flex-col gap-1.5 border-l border-[var(--vex-line)] pl-6">
          {group.calls.map((call) => (
            <ToolActRow
              key={call.toolCallId}
              act={call}
              pendingApprovalId={
                pendingApprovals?.get(call.toolCallId) ?? null
              }
            />
          ))}
        </div>
      </ExpandRegion>
    </div>
  );
}
