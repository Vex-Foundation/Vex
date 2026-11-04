/**
 * THE TURN'S THINKING ROW, AND ITS STEPS (docs/design/H3-DESKTOP.md section
 * 1.7 and Appendix A.7). H3 heads Vex's turn with one framed row, "THOUGHT
 * FOR 2.8s" with "5 steps" at its right; desktop says "{n} steps" for a turn
 * reopened from history, and "Thought for N s" only after a turn it watched
 * live (`TurnIsland/turnClock.ts`).
 *
 * WHICH ROW. The turn's first row that carries a reasoning trace: its
 * Reasoned row is the turn's thinking row, so the count rides on something
 * the reader can open. A turn with no trace at all has no thinking row, and
 * no count is drawn anywhere: an empty row that opens onto nothing would be
 * a worse lie than none.
 *
 * WHAT A STEP IS. What H3 draws as the frame's MODEL and TOOL rows, counted
 * only from what the transcript holds and shows: each persisted reasoning
 * trace is one step (a thought), and each tool call is one step (its act row,
 * a member of a fold, or an orphan result whose call has scrolled away). A
 * notice, a context marker or the answer's prose is not a step. Nothing is
 * inferred: the number is what a reader would count by opening the rows.
 *
 * ONLY WHOLE TURNS. A turn is the rows from the person's message to the next
 * one (`turnMarks.ts`'s boundary). Rows above the first loaded message belong
 * to a turn whose start has not been paged in, so they get no count: part of
 * a turn is not the turn. The newest turn may still be in flight; its count
 * is what has been persisted so far and grows with it.
 *
 * Pure functions over the rendered entries; display only.
 */

import { transcriptEntryKey } from "../agentActivity.js";
import type { TranscriptEntry } from "../transcriptRowModel.js";

/** What the turn's thinking row says beyond its own trace. */
export interface TurnThinkingHead {
  /** The steps the whole turn took, as the transcript shows them. */
  readonly steps: number;
  /** The id of the person's message that opened the turn. */
  readonly anchorId: number;
}

function hasTrace(text: string | null | undefined): boolean {
  return (text ?? "").length > 0;
}

/** Whether this entry carries at least one reasoning trace. */
function carriesTrace(entry: TranscriptEntry): boolean {
  if (entry.variant === "tool_group") return (entry.reasonings ?? []).some(hasTrace);
  if (
    entry.variant === "assistant" ||
    entry.variant === "assistant_stopped" ||
    entry.variant === "tool"
  ) {
    return hasTrace(entry.reasoning);
  }
  return false;
}

/** The steps one entry contributes: its traces and its tool calls. */
export function entrySteps(entry: TranscriptEntry): number {
  switch (entry.variant) {
    case "tool_group":
      return (entry.reasonings ?? []).filter(hasTrace).length + entry.calls.length;
    case "assistant":
    case "assistant_stopped":
      return hasTrace(entry.reasoning) ? 1 : 0;
    case "tool": {
      const thought = hasTrace(entry.reasoning) ? 1 : 0;
      if (entry.toolKind === "result") return thought + 1;
      const calls = entry.toolActs?.length ?? entry.toolCalls?.length ?? 0;
      return thought + calls;
    }
    default:
      return 0;
  }
}

/**
 * The thinking row of every whole turn in `rows`, by the entry key of the row
 * that carries it (`transcriptEntryKey`).
 */
export function turnThinkingHeads(
  rows: readonly TranscriptEntry[],
): ReadonlyMap<string, TurnThinkingHead> {
  const heads = new Map<string, TurnThinkingHead>();
  let anchorId: number | null = null;
  let headKey: string | null = null;
  let steps = 0;
  const close = (): void => {
    if (anchorId !== null && headKey !== null && steps > 0) {
      heads.set(headKey, { steps, anchorId });
    }
  };
  for (const row of rows) {
    if (row.variant === "user") {
      close();
      anchorId = row.id;
      headKey = null;
      steps = 0;
      continue;
    }
    if (anchorId === null) continue;
    steps += entrySteps(row);
    if (headKey === null && carriesTrace(row)) headKey = transcriptEntryKey(row);
  }
  close();
  return heads;
}
