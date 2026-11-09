/**
 * THE FLOW RHYTHM of the transcript column (VEX Cloud's spec 10.10,
 * `thread-model.ts` `FLOW_GAP` and `layoutRows`): no single gap, but each
 * row's place from what it shows at its edges.
 *
 *   6   between rows (a message, a runtime line, the day line) and between
 *       trace cards
 *   12  above and below text or a card (Vex's answer, a receipt, a mission's
 *       result, an analysis), and above the live turn
 *   16  above the turn's head, and below it when the turn is folded to it
 *
 * The later row owns the gap, the larger of the two edges wins, and a row
 * the fold hides adds no gap. A row that only continues the steps of the row
 * above (`continuesStepRun`) joins its card: no gap. Inside one of Vex's
 * rows its parts stand 12 apart (chat-transcript.css).
 *
 * Pure; display only.
 */

import { isVexTurnRow } from "./turnMarks.js";
import { actsCarryCards, drawsToolSteps } from "./turnSteps.js";
import type { TranscriptEntry } from "../transcriptRowModel.js";

/** The flow's gaps, in px. */
export const FLOW_GAP = { row: 6, text: 12, fold: 16 } as const;

export type FlowGap = 0 | 6 | 12 | 16;

/** One visible part of a row, top to bottom. */
type Part = "text" | "group" | "head";

/** What a row shows, in order: its text and cards, and its trace groups. */
function rowParts(row: TranscriptEntry, headed: boolean, shut: boolean): readonly Part[] {
  const thought =
    row.variant !== "tool_group" && (row.reasoning ?? "").length > 0;
  const raw: ("text" | "group")[] = [];
  switch (row.variant) {
    case "assistant":
    case "assistant_stopped":
      if (thought) raw.push("group");
      raw.push("text");
      break;
    case "tool":
      if (row.toolKind === "result") {
        raw.push("group");
        break;
      }
      if (row.content.length > 0) {
        if (thought) raw.push("group");
        raw.push("text");
        if (drawsToolSteps(row)) raw.push("group");
      } else if (thought || drawsToolSteps(row)) {
        raw.push("group");
      }
      if (actsCarryCards(row)) raw.push("text");
      break;
    case "tool_group":
      raw.push("group");
      if (actsCarryCards(row)) raw.push("text");
      break;
    default:
      raw.push("text");
  }
  // The head stands on the row's first group; a folded turn keeps it alone
  // and hides every other group.
  const parts: Part[] = [];
  let headPlaced = false;
  for (const part of raw) {
    if (part === "group" && headed && !headPlaced) {
      headPlaced = true;
      parts.push("head");
      continue;
    }
    if (part === "group" && shut) continue;
    parts.push(part);
  }
  return parts;
}

function topEdge(part: Part): FlowGap {
  return part === "head" ? FLOW_GAP.fold : part === "group" ? FLOW_GAP.row : FLOW_GAP.text;
}

function bottomEdge(part: Part, shut: boolean): FlowGap {
  if (part === "head") return shut ? FLOW_GAP.fold : FLOW_GAP.row;
  return part === "group" ? FLOW_GAP.row : FLOW_GAP.text;
}

/** One row's place in the flow. */
export interface RowFlow {
  /** The gap above the day line drawn over this row, if one is. */
  readonly dayGap: FlowGap | null;
  /** The gap above the row (0 for the first visible row and hidden rows). */
  readonly gap: FlowGap;
  /** Whether the fold hides everything the row shows. */
  readonly hidden: boolean;
}

export interface FlowFacts {
  /** The row carries its turn's head. */
  readonly headed: (row: TranscriptEntry) => boolean;
  /** The row's turn is folded. */
  readonly shut: (row: TranscriptEntry) => boolean;
  /** A day line stands over the row. */
  readonly startsDay: (row: TranscriptEntry, index: number) => boolean;
  /** The row only continues the steps of the row above. */
  readonly continues: (row: TranscriptEntry, index: number) => boolean;
}

export function flowRhythm(
  rows: readonly TranscriptEntry[],
  facts: FlowFacts,
): readonly RowFlow[] {
  let previousBottom: FlowGap | null = null;
  return rows.map((row, index) => {
    let dayGap: FlowGap | null = null;
    if (facts.startsDay(row, index)) {
      dayGap = previousBottom === null ? 0 : (Math.max(previousBottom, FLOW_GAP.row) as FlowGap);
      previousBottom = FLOW_GAP.row;
    }
    const shut = facts.shut(row);
    const parts = isVexTurnRow(row)
      ? rowParts(row, facts.headed(row), shut)
      : (["text"] as const);
    const first = parts[0];
    const last = parts.at(-1);
    if (first === undefined || last === undefined) return { dayGap, gap: 0, hidden: true };
    // A message, a runtime line or a marker: the row's 6 at both edges.
    const top = isVexTurnRow(row) ? topEdge(first) : FLOW_GAP.row;
    const bottom = isVexTurnRow(row) ? bottomEdge(last, shut) : FLOW_GAP.row;
    const joins = first === "group" && dayGap === null && facts.continues(row, index);
    const gap: FlowGap =
      previousBottom === null || joins ? 0 : (Math.max(previousBottom, top) as FlowGap);
    previousBottom = bottom;
    return { dayGap, gap, hidden: false };
  });
}
