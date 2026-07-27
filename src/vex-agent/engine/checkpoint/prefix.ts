/**
 * Checkpoint prefix selection — decides what gets compacted and how.
 *
 * The live-messages array is re-read from DB immediately before checkpoint
 * runs, so every row here carries its canonical `id`. That's what lets us
 * produce a cutoff message id for `archivePrefix`, and a concrete
 * `bloatedMessageId` for the giant-tool fallback.
 *
 * Three outcomes:
 *   - `prefix`: normal compact — everything before the tail goes to archive.
 *   - `giant_tool`: the tail contains a single oversized tool output that is
 *     the sole source of context pressure. We DON'T archive the prefix
 *     (there's nothing compactable left), we fork-copy just the bloated row
 *     and replace its live content with a short placeholder.
 *   - `noop`: nothing to do. The caller (`executeCompactNow`) logs and
 *     returns `{kind: 'noop'}`; the runtime forced-fallback's noop counter
 *     escalates after `COMPACT_MAX_CONSECUTIVE_NOOPS` consecutive misses.
 */

import { selectArchivePrefix } from "@vex-agent/db/repos/messages.js";
import type { MessageWithId } from "@vex-agent/db/repos/messages.js";

export const TAIL_WINDOW = 10;
export const GIANT_TOOL_THRESHOLD = 8_000;

export type CheckpointPlan =
  | {
      mode: "prefix";
      prefix: MessageWithId[];
      tail: MessageWithId[];
      cutoffMessageId: number;
    }
  | {
      mode: "giant_tool";
      bloatedMessageId: number;
      bloatedContent: string;
      virtualPrefix: MessageWithId[];
    }
  | {
      mode: "noop";
      reason: "empty_session" | "no_compactable";
    };

/**
 * Pick a compaction plan for this session's live messages.
 *
 * Order of preference:
 *   1. If `selectArchivePrefix` returns a non-empty prefix, archive it.
 *   2. Otherwise scan the tail for the largest `role:'tool'` row. If it
 *      exceeds `giantThreshold`, build a virtual prefix of `[parent
 *      assistant, bloated tool]` so summarize/extract still have context.
 *   3. Otherwise bail out with `noop`.
 */
export function selectPrefixWithGiantFallback(
  messages: readonly MessageWithId[],
  tailWindow: number = TAIL_WINDOW,
  giantThreshold: number = GIANT_TOOL_THRESHOLD,
): CheckpointPlan {
  if (messages.length === 0) {
    return { mode: "noop", reason: "empty_session" };
  }

  const plan = selectArchivePrefix(messages, tailWindow);
  if (plan.prefix.length > 0 && plan.cutoffMessageId !== null) {
    return {
      mode: "prefix",
      prefix: [...plan.prefix],
      tail: [...plan.tail],
      cutoffMessageId: plan.cutoffMessageId,
    };
  }

  // Nothing compactable via pair-preserving prefix → look for a giant tool.
  const giant = findLargestToolMessage(messages);
  if (!giant || giant.message.content.length <= giantThreshold) {
    return { mode: "noop", reason: "no_compactable" };
  }

  const parent = findParentAssistant(messages, giant.index, giant.message.toolCallId);
  const virtualPrefix: MessageWithId[] = parent
    ? [parent, giant.message]
    : [giant.message];

  return {
    mode: "giant_tool",
    bloatedMessageId: giant.message.id,
    bloatedContent: giant.message.content,
    virtualPrefix,
  };
}

// ── Helpers ────────────────────────────────────────────────────

function findLargestToolMessage(
  messages: readonly MessageWithId[],
): { message: MessageWithId; index: number } | null {
  let best: { message: MessageWithId; index: number } | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    // Tool outputs are persisted verbatim inline (D-4 removed the blob
    // externalisation), so every live tool row here carries its real body and
    // is a legitimate candidate. LEGACY short stubs may still exist in old
    // transcripts; they need no skip branch because a stub can never be the
    // largest message nor reach the giant-message threshold.
    if (!best || m.content.length > best.message.content.length) {
      best = { message: m, index: i };
    }
  }
  return best;
}

function findParentAssistant(
  messages: readonly MessageWithId[],
  toolIndex: number,
  toolCallId: string | undefined,
): MessageWithId | null {
  if (!toolCallId) return null;
  for (let i = toolIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (!m.toolCalls || m.toolCalls.length === 0) continue;
    const matches = m.toolCalls.some((tc) => tc.id === toolCallId);
    if (matches) return m;
    // An earlier assistant without this call-id means our tool is orphaned
    // (shouldn't happen given the save ordering, but bail out cleanly).
    return null;
  }
  return null;
}
