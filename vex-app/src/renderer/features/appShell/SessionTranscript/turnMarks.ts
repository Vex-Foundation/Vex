/**
 * WHERE VEX'S TOKEN HANGS. Vex's turn hangs off the flat vx token once per
 * turn (docs/design/R3-MINIMAL.md section 6): the first row Vex writes after
 * the reader's message carries it, and every later row of the same turn sits
 * on the same 40px edge without a second token. Pure functions over the
 * rendered entries; display only.
 */

import { transcriptEntryKey } from "../agentActivity.js";
import type { TranscriptEntry } from "../transcriptRowModel.js";

/**
 * A row Vex writes into her turn: prose, a stopped reply, a tool step or a
 * fold of steps. Notices and context markers are the system's, centred, and
 * never carry the token.
 */
export function isVexTurnRow(entry: TranscriptEntry): boolean {
  return (
    entry.variant === "assistant" ||
    entry.variant === "assistant_stopped" ||
    entry.variant === "tool" ||
    entry.variant === "tool_group"
  );
}

/** Entry keys of the rows that head a Vex turn and so carry the token. */
export function turnMarkKeys(
  rows: readonly TranscriptEntry[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  let marked = false;
  for (const row of rows) {
    if (row.variant === "user") {
      marked = false;
      continue;
    }
    if (!marked && isVexTurnRow(row)) {
      keys.add(transcriptEntryKey(row));
      marked = true;
    }
  }
  return keys;
}

/**
 * Whether the turn in flight still owes its token: no row since the reader's
 * last message has carried it, so the live row is the turn's first.
 */
export function liveTurnNeedsMark(rows: readonly TranscriptEntry[]): boolean {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row === undefined) continue;
    if (row.variant === "user") return true;
    if (isVexTurnRow(row)) return false;
  }
  return true;
}

/**
 * Whether a row only continues the step list of the row above it (a
 * prose-less tool row right under another tool row or fold), so the two read
 * as one ruled list instead of two.
 */
export function continuesStepRun(
  row: TranscriptEntry,
  prev: TranscriptEntry | undefined,
): boolean {
  if (prev === undefined) return false;
  const prevIsSteps = prev.variant === "tool" || prev.variant === "tool_group";
  if (!prevIsSteps) return false;
  if (row.variant === "tool_group") return (row.reasonings ?? []).length === 0;
  if (row.variant !== "tool") return false;
  return row.content.length === 0 && (row.reasoning ?? "").length === 0;
}
