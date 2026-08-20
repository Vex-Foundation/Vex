/**
 * THE ROW LIST — how a transcript row is framed, and which arrivals animate.
 *
 * Move-only extraction from `SessionTranscript.tsx` when the polish wave pushed
 * that file past its line budget. Behaviour is unchanged; the parent still owns
 * the scroll model, the anchor and every query.
 *
 * Two rules live here and nowhere else:
 *  1. TURN RHYTHM — the list gap is the 12px intra-turn beat; a USER row starts
 *     a new turn, so its extra `mt-4` totals the 28px turn spacing.
 *  2. WHAT ANIMATES — only rows appended LIVE (id outside the settled set).
 *     History, including load-older prepends, hard-cuts. A tool group keeps its
 *     first call row's id, so its status matches its members'.
 *
 * The animation rides an INNER wrapper, never the element carrying
 * `data-vex-entry-id`: the parent's top-anchor layout effect measures that
 * element's rect before paint, and a transform on it would offset the anchor by
 * the animation's opening frame. A descendant's transform cannot move its
 * parent's border box, so the scroll model always measures an untransformed row.
 */

import { Fragment, type JSX } from "react";
import { cn } from "../../../lib/utils.js";
import { TranscriptMessage } from "../TranscriptMessage.js";
import { transcriptEntryKey as entryKey } from "../agentActivity.js";
import type { TranscriptEntry } from "../transcriptRowModel.js";
import { crossesLocalDay, dayLabel } from "./daySeparator.js";

/**
 * G12 — a quiet Doto date stamp between rows from different LOCAL calendar
 * days (and above the very first loaded row, so a resumed session names its
 * day). Chrome, not content: aria-hidden, hairline-flanked.
 */
function DaySeparator({ iso }: { readonly iso: string }): JSX.Element | null {
  const label = dayLabel(iso, Date.now());
  if (label === null) return null;
  return (
    <div
      aria-hidden
      data-vex-day-separator=""
      className="flex items-center gap-3"
    >
      <span className="h-px flex-1 bg-line-1" />
      <span className="vex-stat-doto">{label}</span>
      <span className="h-px flex-1 bg-line-1" />
    </div>
  );
}

export function TranscriptRows({
  rows,
  sessionId,
  settledIds,
  pendingApprovals,
  workingAgentEntryKey,
}: {
  readonly rows: readonly TranscriptEntry[];
  /** Owning session - stamps each row's per-message feedback context (G7). */
  readonly sessionId: string;
  /** Ids that are HISTORY. `null` while the first page is still landing. */
  readonly settledIds: ReadonlySet<number> | null;
  readonly pendingApprovals: ReadonlyMap<string, string>;
  readonly workingAgentEntryKey: string | null;
}): JSX.Element {
  return (
    <>
      {rows.map((row, index) => {
        const liveAppend = settledIds !== null && !settledIds.has(row.id);
        const prev = index > 0 ? rows[index - 1] : undefined;
        const startsDay =
          prev === undefined || crossesLocalDay(prev.createdAt, row.createdAt);
        return (
          <Fragment key={entryKey(row)}>
          {startsDay ? <DaySeparator iso={row.createdAt} /> : null}
          <div
            data-vex-entry-id={row.id}
            data-vex-entry-variant={row.variant}
            className={cn(row.variant === "user" && "mt-4")}
          >
            <div
              className={cn(
                liveAppend &&
                  // The user's own message gets the fuller SEND entry; every
                  // other live arrival keeps the quieter print.
                  (row.variant === "user"
                    ? "vex-message-send"
                    : "vex-entry-settle"),
              )}
            >
              <TranscriptMessage
                row={row}
                pendingApprovals={pendingApprovals}
                agentWorking={workingAgentEntryKey === entryKey(row)}
                feedbackSessionId={sessionId}
                feedbackMessageKey={entryKey(row)}
              />
            </div>
          </div>
          </Fragment>
        );
      })}
    </>
  );
}
