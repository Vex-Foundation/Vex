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

import type { JSX } from "react";
import type { ReactNode } from "react";
import { cn } from "../../../lib/utils.js";
import { TranscriptMessage } from "../TranscriptMessage.js";
import { transcriptEntryKey as entryKey } from "../agentActivity.js";
import type { TranscriptEntry } from "../transcriptRowModel.js";

export function TranscriptRows({
  rows,
  settledIds,
  pendingApprovals,
  workingAgentEntryKey,
  lighterPreviewActionRowId,
  lighterPreviewAction,
}: {
  readonly rows: readonly TranscriptEntry[];
  /** Ids that are HISTORY. `null` while the first page is still landing. */
  readonly settledIds: ReadonlySet<number> | null;
  readonly pendingApprovals: ReadonlyMap<string, string>;
  readonly workingAgentEntryKey: string | null;
  readonly lighterPreviewActionRowId?: number | null;
  readonly lighterPreviewAction?: ReactNode;
}): JSX.Element {
  return (
    <>
      {rows.map((row) => {
        const liveAppend = settledIds !== null && !settledIds.has(row.id);
        return (
          <div key={entryKey(row)}>
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
                />
              </div>
            </div>
            {lighterPreviewActionRowId === row.id &&
            lighterPreviewAction !== undefined ? (
              <div className="mt-3">{lighterPreviewAction}</div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
