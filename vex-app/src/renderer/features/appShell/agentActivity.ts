import type { TranscriptEntry } from "./transcriptRowModel.js";

/**
 * React key for a transcript entry. One source DTO id can appear on multiple
 * rendered entries, so tool variants are prefixed to keep keys distinct.
 */
export function transcriptEntryKey(entry: TranscriptEntry): string {
  if (entry.variant === "tool_group") return `tg-${entry.id}`;
  if (entry.variant === "tool") return `t-${entry.id}`;
  return String(entry.id);
}

/** Whether this row owns an assistant avatar in `TranscriptMessage`. */
function hasAgentAvatar(entry: TranscriptEntry): boolean {
  return (
    entry.variant === "assistant" ||
    entry.variant === "assistant_stopped" ||
    (entry.variant === "tool" &&
      entry.toolKind === "call" &&
      entry.content.length > 0)
  );
}

/**
 * Select the newest assistant avatar after the current turn's user message.
 * A previous turn must never start spinning while the new turn has not yet
 * produced assistant prose.
 */
export function findWorkingAgentEntryKey(
  rows: readonly TranscriptEntry[],
  chatSubmitting: boolean,
): string | null {
  if (!chatSubmitting) return null;
  let latestUserIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.variant === "user") {
      latestUserIndex = i;
      break;
    }
  }
  for (let i = rows.length - 1; i > latestUserIndex; i -= 1) {
    const row = rows[i];
    if (row !== undefined && hasAgentAvatar(row)) {
      return transcriptEntryKey(row);
    }
  }
  return null;
}
