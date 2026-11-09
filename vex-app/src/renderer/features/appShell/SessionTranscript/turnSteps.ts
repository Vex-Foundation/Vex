/**
 * THE TURN'S TRACE: its head and its steps (docs/design/H3-DESKTOP.md
 * section 1.7 and Appendix A.7; VEX Cloud's built trace, `TraceCard.tsx` and
 * `trace-steps.ts`). One head per turn folds every step of the turn: "THOUGHT
 * FOR 2.8s" with "5 steps" at its right after a turn watched live
 * (`TurnIsland/turnClock.ts`), "Thought" and its steps for a turn reopened
 * from history, "Stopped" or "Failed" as a label that never folds.
 *
 * WHICH ROW. The turn's first row that carries a step, a thought or a tool
 * call: the head stands right over that row's first step part
 * (`TurnTrace.tsx`), so a turn that only called tools still has its head, and
 * a turn that opens with prose keeps the head at its first step.
 *
 * WHAT A STEP IS. What H3 draws as the trace's MODEL and TOOL rows, counted
 * only from what the transcript holds and shows: each persisted reasoning
 * trace is one step (a thought), and each tool call is one step (its act row,
 * a member of a fold, or an orphan result whose call has scrolled away). A
 * notice, a context marker or the answer's prose is not a step. Nothing is
 * inferred: the number is what a reader would count by opening the rows.
 *
 * ONLY WHOLE TURNS. A turn is the rows from the person's message to the next
 * one (`turnMarks.ts`'s boundary). Rows above the first loaded message belong
 * to a turn whose start has not been paged in, so they get no head and never
 * fold: part of a turn is not the turn. The newest turn may still be in
 * flight; its count is what has been persisted so far and grows with it.
 *
 * THE OUTCOME. A turn with a stopped reply was stopped; one with an error
 * notice failed; any other is complete. Only a complete (or running) turn
 * folds (Cloud's decision 4).
 *
 * Pure functions over the rendered entries; display only.
 */

import { transcriptEntryKey } from "../agentActivity.js";
import { readMissionStopResult } from "../ToolLedger/MissionStopResult.js";
import { receiptTxRef } from "../ToolLedger/ReceiptCard.js";
import { readTechnicalAnalysisResult } from "../ToolLedger/TechnicalAnalysisResult.js";
import type {
  ToolCallActView,
  TranscriptEntry,
} from "../transcriptRowModel.js";

/** How a whole turn ended, as its rows say it. */
export type TurnOutcome = "completed" | "stopped" | "failed";

/** What the turn's head says. */
export interface TurnThinkingHead {
  /** The steps the whole turn took, as the transcript shows them. */
  readonly steps: number;
  /** The id of the person's message that opened the turn. */
  readonly anchorId: number;
  readonly outcome: TurnOutcome;
}

/** Every whole turn's head, and the turn each of its rows belongs to. */
export interface TurnTraces {
  /** The head, by the entry key of the row it stands on. */
  readonly heads: ReadonlyMap<string, TurnThinkingHead>;
  /** The opening message's id, by the entry key of every row after it. */
  readonly turnOf: ReadonlyMap<string, number>;
  /** The newest whole turn's opening message, or null. */
  readonly lastAnchorId: number | null;
}

function hasTrace(text: string | null | undefined): boolean {
  return (text ?? "").length > 0;
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

/** The acts a tool row draws (`TranscriptMessage`'s `resolveActs`). */
function rowActs(entry: TranscriptEntry): readonly ToolCallActView[] {
  if (entry.variant === "tool_group") return entry.calls;
  if (entry.variant !== "tool" || entry.toolKind === "result") return [];
  if (entry.toolActs !== undefined) return entry.toolActs;
  return (entry.toolCalls ?? []).map((call) => ({ ...call, output: null }));
}

/**
 * Whether a row holds nothing but steps, so a shut fold leaves nothing of it
 * on screen: an orphan result, or a prose-less call row or fold whose acts
 * carry no receipt, mission result or analysis (those never fold away).
 */
export function foldsWhole(entry: TranscriptEntry): boolean {
  if (entry.variant === "tool" && entry.toolKind === "result") return true;
  if (entry.variant === "tool" && entry.content.length > 0) return false;
  if (entry.variant !== "tool" && entry.variant !== "tool_group") return false;
  return rowActs(entry).every(
    (act) =>
      receiptTxRef(act) === null &&
      readMissionStopResult(act) === null &&
      readTechnicalAnalysisResult(act) === null,
  );
}

/** Every whole turn in `rows`: its head, and which turn each row is in. */
export function turnTraces(rows: readonly TranscriptEntry[]): TurnTraces {
  const heads = new Map<string, TurnThinkingHead>();
  const turnOf = new Map<string, number>();
  let anchorId: number | null = null;
  let headKey: string | null = null;
  let steps = 0;
  let outcome: TurnOutcome = "completed";
  const close = (): void => {
    if (anchorId !== null && headKey !== null && steps > 0) {
      heads.set(headKey, { steps, anchorId, outcome });
    }
  };
  for (const row of rows) {
    if (row.variant === "user") {
      close();
      anchorId = row.id;
      headKey = null;
      steps = 0;
      outcome = "completed";
      continue;
    }
    if (anchorId === null) continue;
    const key = transcriptEntryKey(row);
    turnOf.set(key, anchorId);
    const own = entrySteps(row);
    steps += own;
    if (headKey === null && own > 0) headKey = key;
    if (row.variant === "assistant_stopped") outcome = "stopped";
    else if (
      row.variant === "notice" &&
      row.noticeTone === "error" &&
      outcome === "completed"
    ) {
      outcome = "failed";
    }
  }
  close();
  return { heads, turnOf, lastAnchorId: anchorId };
}

/**
 * The head of every whole turn in `rows`, by the entry key of the row it
 * stands on (`transcriptEntryKey`).
 */
export function turnThinkingHeads(
  rows: readonly TranscriptEntry[],
): ReadonlyMap<string, TurnThinkingHead> {
  return turnTraces(rows).heads;
}
