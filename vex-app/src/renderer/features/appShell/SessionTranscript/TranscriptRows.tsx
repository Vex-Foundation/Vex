/**
 * THE ROW LIST - how a transcript row is framed, and which arrivals animate.
 *
 * Move-only extraction from `SessionTranscript.tsx` when the polish wave pushed
 * that file past its line budget. Behaviour is unchanged; the parent still owns
 * the scroll model, the anchor and every query.
 *
 * Three rules live here and nowhere else:
 *  1. TURN RHYTHM - the list gap is the 18px beat of the page; a USER row
 *     starts a new turn, so its extra `mt-1` opens the turn (22 above it,
 *     docs/design/R3-MINIMAL.md section 6). A prose-less tool row that only
 *     continues the step run above it takes the gap back
 *     (`data-vex-run-continues`), so one run reads as one ruled list.
 *  2. WHAT ANIMATES - only rows appended LIVE (id outside the settled set).
 *     History, including load-older prepends, hard-cuts. A tool group keeps its
 *     first call row's id, so its status matches its members'. The SAME
 *     decision travels on as `boardArrival`, so a board card's unseen dot and
 *     this animation can never disagree about which rows are new: a null
 *     `settledIds` (first page still landing) is history for both.
 *  3. THE TURN'S HEAD - only the row that heads Vex's turn is stamped as its
 *     head (`turnMarks.ts`), and the turn's first row with a step carries
 *     the trace's head over its first step part, which says the turn's steps
 *     and, after a turn watched live, its measured time (`turnSteps.ts`,
 *     `TurnIsland/turnClock.ts`, `TurnTrace.tsx`). The head folds every step
 *     of the turn (`turnFold.ts`); a row that holds nothing but steps takes
 *     its gap back while its turn is folded (`data-vex-trace-shut`), so a
 *     folded turn reads as its head and its answer.
 *
 * The animation rides an INNER wrapper, never the element carrying
 * `data-vex-entry-id` / `data-vex-anchor-key`. That element is the scroll
 * model's measurement unit: it reads the row's border box with
 * `getBoundingClientRect()` to capture and restore a paging anchor or a saved
 * reader position, in the same commit a live row mounts in. A transform on the
 * row itself would fold the animation's opening offset into the restored
 * `scrollTop`; a descendant's transform cannot move its parent's border box,
 * so the model always measures an untransformed row. The same holds for the
 * top anchor: a sent row is written to the top of the view in the commit it
 * mounts in, while its `vex-message-send` entry is still offset.
 *
 * `data-vex-anchor-key` is `transcriptEntryKey(row)`, not `row.id`: a tool
 * GROUP borrows its first call's id, so the id alone is not a stable identity
 * for an anchor that must survive regrouping across a prepend.
 */

import { Fragment, useMemo, type JSX } from "react";
import { cn } from "../../../lib/utils.js";
import { TranscriptMessage } from "../TranscriptMessage.js";
import { transcriptEntryKey as entryKey } from "../agentActivity.js";
import type { TranscriptEntry } from "../transcriptRowModel.js";
import { crossesLocalDay, dayLabel } from "./daySeparator.js";
import { continuesStepRun, turnMarkKeys } from "./turnMarks.js";
import { foldsWhole, turnTraces } from "./turnSteps.js";
import { TurnFoldContext, useTurnFold, type TurnFoldView } from "./turnFold.js";
import { useTurnClock } from "../TurnIsland/turnClock.js";
import type { MessageForkActions } from "./useMessageForkActions.js";

/**
 * G12 - the day label: "Today", "Yesterday" or the date, 12 muted and centred
 * (docs/design/R3-MINIMAL.md section 6), between rows from different LOCAL
 * calendar days and above the very first loaded row, so a resumed session
 * names its day. Chrome, not content: aria-hidden.
 */
function DaySeparator({ iso }: { readonly iso: string }): JSX.Element | null {
  const label = dayLabel(iso, Date.now());
  if (label === null) return null;
  return (
    <div aria-hidden data-vex-day-separator="" className="vex-day">
      {label}
    </div>
  );
}

export function TranscriptRows({
  rows,
  sessionId,
  settledIds,
  pendingApprovals,
  workingAgentEntryKey,
  forkActions,
  live = false,
}: {
  readonly rows: readonly TranscriptEntry[];
  /** Owning session - stamps each row's per-message feedback context (G7). */
  readonly sessionId: string;
  /** Ids that are HISTORY. `null` while the first page is still landing. */
  readonly settledIds: ReadonlySet<number> | null;
  readonly pendingApprovals: ReadonlyMap<string, string>;
  readonly workingAgentEntryKey: string | null;
  /** Branch/edit hover keys (A14/A18); omitted = read-only transcript. */
  readonly forkActions?: MessageForkActions;
  /** A turn is in flight (the live frame shows at the tail). */
  readonly live?: boolean;
}): JSX.Element {
  const markKeys = useMemo(() => turnMarkKeys(rows), [rows]);
  // Each whole turn's head, its steps and the message that opened it, and
  // the turn every row is in (`turnSteps.ts`); the live turn clock's
  // readings for this session (`turnClock.ts`): only turns watched live have
  // one.
  const traces = useMemo(() => turnTraces(rows), [rows]);
  const turnClock = useTurnClock(sessionId);
  // The newest turn's rows that arrived live: what proves it is running.
  const lastLiveRows = useMemo(() => {
    if (settledIds === null || traces.lastAnchorId === null) return 0;
    let count = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row === undefined) continue;
      if (!settledIds.has(row.id)) count += 1;
      if (row.variant === "user") break;
    }
    return count;
  }, [rows, settledIds, traces.lastAnchorId]);
  const fold = useTurnFold({
    sessionId,
    lastAnchorId: traces.lastAnchorId,
    lastLiveRows,
    live,
  });
  const foldView = useMemo<TurnFoldView>(() => {
    const shut = new Set<number>();
    for (const head of traces.heads.values()) {
      if (head.outcome === "completed" && !fold.isOpen(head.anchorId)) {
        shut.add(head.anchorId);
      }
    }
    return {
      shut,
      runningAnchorId: fold.runningAnchorId,
      toggle: fold.toggle,
      reveal: fold.reveal,
    };
  }, [fold, traces.heads]);
  return (
    <TurnFoldContext.Provider value={foldView}>
      {rows.map((row, index) => {
        const liveAppend = settledIds !== null && !settledIds.has(row.id);
        const prev = index > 0 ? rows[index - 1] : undefined;
        const startsDay =
          prev === undefined || crossesLocalDay(prev.createdAt, row.createdAt);
        const continues = !startsDay && continuesStepRun(row, prev);
        const key = entryKey(row);
        const thinkingHead = traces.heads.get(key);
        const anchorId = traces.turnOf.get(key);
        const traceShut =
          anchorId !== undefined && foldView.shut.has(anchorId) && foldsWhole(row);
        return (
          <Fragment key={entryKey(row)}>
            {startsDay ? <DaySeparator iso={row.createdAt} /> : null}
            <div
              data-vex-entry-id={row.id}
              data-vex-entry-variant={row.variant}
              data-vex-anchor-key={entryKey(row)}
              data-vex-run-continues={continues ? "" : undefined}
              data-vex-trace-shut={traceShut ? "" : undefined}
              className={cn(row.variant === "user" && "mt-1")}
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
                  boardArrival={liveAppend ? "live-append" : "settled"}
                  agentWorking={workingAgentEntryKey === entryKey(row)}
                  turnMark={markKeys.has(entryKey(row))}
                  sessionId={sessionId}
                  turnAnchorId={anchorId}
                  turnSteps={thinkingHead?.steps}
                  turnOutcome={thinkingHead?.outcome}
                  thoughtMs={
                    thinkingHead === undefined
                      ? undefined
                      : turnClock.get(thinkingHead.anchorId)
                  }
                  feedbackSessionId={sessionId}
                  feedbackMessageKey={entryKey(row)}
                  onEditMessage={forkActions?.onEditMessage}
                  onEditInNewBranch={forkActions?.onEditInNewBranch}
                  onBranchFrom={forkActions?.onBranchFrom}
                />
              </div>
            </div>
          </Fragment>
        );
      })}
    </TurnFoldContext.Provider>
  );
}
