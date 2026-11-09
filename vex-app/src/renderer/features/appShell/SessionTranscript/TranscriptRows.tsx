/**
 * THE ROW LIST - how a transcript row is framed, and which arrivals animate.
 *
 * Move-only extraction from `SessionTranscript.tsx` when the polish wave pushed
 * that file past its line budget. Behaviour is unchanged; the parent still owns
 * the scroll model, the anchor and every query.
 *
 * Three rules live here and nowhere else:
 *  1. FLOW RHYTHM - no single gap: each row's gap comes from what it shows
 *     at its edges (VEX Cloud's 6 / 12 / 16, `flowRhythm.ts`), stamped as
 *     `data-vex-gap` and set by chat-transcript.css. A prose-less tool row
 *     that only continues the step run above it joins its card with no gap
 *     (`data-vex-run-continues`), and a row the fold hides adds none
 *     (`data-vex-trace-shut`).
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
 *     of the turn (`turnFold.ts`); a folded turn reads as its head and its
 *     answer.
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
import { flowRhythm } from "./flowRhythm.js";
import { turnTraces } from "./turnSteps.js";
import { TurnFoldContext, useTurnFold, type TurnFoldView } from "./turnFold.js";
import { useTurnClock } from "../TurnIsland/turnClock.js";
import type { MessageForkActions } from "./useMessageForkActions.js";

/**
 * G12 - the day line: "Today", "Yesterday" or the date, caps 11 muted and
 * centred between two fading hairlines (VEX Cloud's `.vx-tx-day`), between
 * rows from different LOCAL calendar days and above the very first loaded
 * row, so a resumed session names its day. Chrome, not content: aria-hidden.
 */
function DaySeparator({
  iso,
  gap,
}: {
  readonly iso: string;
  /** Its place in the flow rhythm (`flowRhythm.ts`). */
  readonly gap: number;
}): JSX.Element | null {
  const label = dayLabel(iso, Date.now());
  if (label === null) return null;
  return (
    <div aria-hidden data-vex-day-separator="" data-vex-gap={gap} className="vex-day">
      <span>{label}</span>
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
  // The latest message of each speaker: the person's newest, and Vex's
  // newest answer after it. Their keys always show (VEX Cloud's
  // `TurnActions` and `UserMessage`); every other row's on hover.
  const latestKeys = useMemo(() => {
    const keys = new Set<string>();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row === undefined) continue;
      if (row.variant === "user") {
        keys.add(entryKey(row));
        break;
      }
      if (
        (row.variant === "assistant" || row.variant === "assistant_stopped") &&
        keys.size === 0
      ) {
        keys.add(entryKey(row));
      }
    }
    return keys;
  }, [rows]);
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
  // Where a day line stands, and which rows only continue the steps above.
  const startsDayAt = (row: TranscriptEntry, index: number): boolean => {
    const prev = index > 0 ? rows[index - 1] : undefined;
    return prev === undefined || crossesLocalDay(prev.createdAt, row.createdAt);
  };
  const continuesAt = (row: TranscriptEntry, index: number): boolean =>
    !startsDayAt(row, index) && continuesStepRun(row, index > 0 ? rows[index - 1] : undefined);
  // The flow rhythm (`flowRhythm.ts`): every row's gap from its edges.
  // Memoized: the list re-renders at the live preview's rate, and the rhythm
  // reads each row's acts.
  const flow = useMemo(
    () =>
      flowRhythm(rows, {
        headed: (row) => traces.heads.has(entryKey(row)),
        shut: (row) => {
          const anchorId = traces.turnOf.get(entryKey(row));
          return anchorId !== undefined && foldView.shut.has(anchorId);
        },
        startsDay: (row, index) => {
          const prev = index > 0 ? rows[index - 1] : undefined;
          return prev === undefined || crossesLocalDay(prev.createdAt, row.createdAt);
        },
        continues: (row, index) => {
          const prev = index > 0 ? rows[index - 1] : undefined;
          return (
            prev !== undefined &&
            !crossesLocalDay(prev.createdAt, row.createdAt) &&
            continuesStepRun(row, prev)
          );
        },
      }),
    [rows, traces, foldView],
  );
  return (
    <TurnFoldContext.Provider value={foldView}>
      {rows.map((row, index) => {
        const liveAppend = settledIds !== null && !settledIds.has(row.id);
        const startsDay = startsDayAt(row, index);
        const continues = continuesAt(row, index);
        const key = entryKey(row);
        const thinkingHead = traces.heads.get(key);
        const anchorId = traces.turnOf.get(key);
        const place = flow[index] ?? { dayGap: null, gap: 0, hidden: false };
        return (
          <Fragment key={entryKey(row)}>
            {startsDay ? <DaySeparator iso={row.createdAt} gap={place.dayGap ?? 0} /> : null}
            <div
              data-vex-entry-id={row.id}
              data-vex-entry-variant={row.variant}
              data-vex-anchor-key={entryKey(row)}
              data-vex-run-continues={continues ? "" : undefined}
              data-vex-trace-shut={place.hidden ? "" : undefined}
              data-vex-gap={place.gap}
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
                  latest={latestKeys.has(key)}
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
