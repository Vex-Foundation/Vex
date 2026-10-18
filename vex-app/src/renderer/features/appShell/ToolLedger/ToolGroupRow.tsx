/**
 * THE FOLD (S5): finished steps in ONE quiet row (docs/design/R3-MINIMAL.md
 * section 6): the chevron, "{n} tool calls · {titles}" (each title carries its
 * venue, "Market data · DexScreener"), the time spent in the tools in the mono
 * 12 at the right. 30 high, 13 muted. Opening it reveals the member
 * `ToolActRow`s, each its own 36px step row. It folds a run the row model
 * grouped and the several calls of one call row alike.
 *
 * Nothing that needs the reader is ever hidden by the fold: a member that
 * failed puts "{k} failed" with the ink cross on the folded row, and a member
 * matched to a pending approval puts its "Waiting for approval" link there.
 *
 * The reveal is the shared `ExpandRegion` primitive (one curve, one duration,
 * one closed-content contract app-wide); the members carry no entrance
 * keyframe of their own, since the expand IS the arrival.
 */

import { useId, useMemo, useRef, useState, type JSX } from "react";
import {
  LineChevronDown,
  LineChevronRight,
} from "../../../components/icons/line/index.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { ExpandRegion } from "../../../components/ui/expand-region.js";
import type { ToolGroupRowModel } from "../transcriptRowModel.js";
import { ApprovalLinkStamp } from "./ApprovalLinkStamp.js";
import { ToolActRow } from "./ToolActRow.js";
import { formatToolDuration } from "./toolDuration.js";
import { resolveToolIdentity } from "./toolIdentity.js";

/**
 * The members' human titles, deduped in first-appearance order. A folded call
 * has its args, so the identity resolves the venue the same way its own step
 * row does.
 */
function foldTitles(group: ToolGroupRowModel): string {
  const titles: string[] = [];
  for (const call of group.calls) {
    const title = resolveToolIdentity(call.toolName, call.toolArgs).title;
    if (!titles.includes(title)) titles.push(title);
  }
  return titles.join(", ");
}

/**
 * Time spent in the folded tools: the sum of the MEASURED durations, and only
 * when every member was measured. One unmeasured member makes the sum a
 * guess, and `null` is not zero, so the fold then prints no time at all.
 */
function foldDurationMs(group: ToolGroupRowModel): number | null {
  if (group.calls.length === 0) return null;
  let total = 0;
  for (const call of group.calls) {
    const ms = call.durationMs;
    if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
      return null;
    }
    total += ms;
  }
  return total;
}

/** Members whose failure the engine persisted (an ambiguous broadcast is not one). */
function failedCount(group: ToolGroupRowModel): number {
  return group.calls.filter(
    (call) => call.success === false && call.displayStatus !== "pending",
  ).length;
}

export function ToolGroupRow({
  group,
  pendingApprovals,
}: {
  readonly group: ToolGroupRowModel;
  /** toolCallId to PENDING approval id for the active session (S5). */
  readonly pendingApprovals?: ReadonlyMap<string, string>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titles = useMemo(() => foldTitles(group), [group]);
  const durationText = formatToolDuration(foldDurationMs(group));
  const failed = failedCount(group);
  // First matched member carries the fold's link target.
  const matchedApprovalId =
    pendingApprovals === undefined
      ? null
      : (group.calls
          .map((call) => pendingApprovals.get(call.toolCallId))
          .find((id) => id !== undefined) ?? null);
  return (
    <div
      // Semantic contract: the fold container is a tool row too.
      data-vex-message-role="tool"
      data-vex-tool-fold=""
      className="vex-steps"
    >
      <div className="vex-step vex-step--quiet flex items-center">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="vex-step__key"
        >
          <span aria-hidden className="vex-step__chev">
            {open ? <LineChevronDown size={14} /> : <LineChevronRight size={14} />}
          </span>
          <span className="vex-step__title">
            <span className="tabular-nums">{group.calls.length} tool calls</span>
            {titles.length > 0 ? ` · ${titles}` : null}
          </span>
          {failed > 0 ? (
            <span data-vex-tool-fold-failed="" className="vex-step__failed">
              <Swatch state="error" size={10} />
              {failed} failed
            </span>
          ) : null}
          <span aria-hidden className="vex-step__spacer" />
          {durationText !== null ? (
            <span data-vex-tool-duration="" className="vex-step__num">
              {durationText}
            </span>
          ) : null}
        </button>
        {matchedApprovalId !== null ? (
          <ApprovalLinkStamp approvalId={matchedApprovalId} />
        ) : null}
      </div>
      <ExpandRegion
        id={bodyId}
        open={open}
        triggerRef={triggerRef}
        className="vex-steps__members"
      >
        {/* Member steps, each its own ruled row under the fold. The rows
            carry no entrance keyframe: the reveal is the expand itself. */}
        {group.calls.map((call) => (
          <ToolActRow
            key={call.toolCallId}
            act={call}
            pendingApprovalId={pendingApprovals?.get(call.toolCallId) ?? null}
          />
        ))}
      </ExpandRegion>
    </div>
  );
}
