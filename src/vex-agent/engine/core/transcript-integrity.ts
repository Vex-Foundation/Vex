/**
 * Transcript integrity — in-flight repair of the tool-call tape.
 *
 * Two defects, one owner. Tool-call ID UNIQUENESS is delegated to
 * `inference/tool-call-id-normalization.ts` and runs first (a provider rejects
 * a tape whose ids repeat, and an id-matching orphan walk cannot reason about
 * one id meaning two calls). ORPHANED tool_calls are repaired here:
 *
 * Problem: when a previous turn was interrupted between dispatching a model's
 * tool_calls and persisting their tool_results (process kill, crash, partial
 * provider failure, etc.), the live message tape contains an `assistant`
 * row with `tool_calls` whose matching `tool` follow-ups never landed.
 * Replaying that conversation to a chat-completions API now triggers strict
 * validation errors (DeepSeek surfaces this as "Function call should not be
 * used with prefix"; Anthropic and OpenAI reject the same shape with their
 * own messages — every tool_use id MUST be followed by a tool_result).
 *
 * Solution: scan the provider message array chronologically and, for any
 * `assistant{tool_calls}` whose ids are not all matched by an immediately
 * adjacent run of `role:"tool"` rows, splice synthetic placeholder tool
 * results in *right after the assistant turn* (preserving the strict
 * `assistant → tool*` adjacency every provider expects).
 *
 * This module is pure and side-effect-free — no DB writes. The repair
 * exists only on the provider request body for the current call. The DB
 * tape stays as-is and is repaired the same way on the next turn. Durable
 * persistence would require inserting rows in the middle of an
 * autoincrement-id history, which is a much larger schema concern; the
 * in-flight approach is exact, idempotent, and provider-agnostic.
 */

import type { ProviderMessage } from "@vex-agent/inference/types.js";
import { normalizeToolCallIds } from "@vex-agent/inference/tool-call-id-normalization.js";
import logger from "@utils/logger.js";

export const TOOL_RESULT_PLACEHOLDER_CONTENT =
  "[Engine: tool execution did not complete — placeholder]";

export interface RepairOutcome {
  /** Possibly-mutated message array. New array; original input is unchanged. */
  readonly messages: ProviderMessage[];
  /** Number of synthetic `role:"tool"` rows inserted. 0 means the input was clean. */
  readonly insertedPlaceholders: number;
  /** Tool calls whose id repeated an earlier declaration and was rewritten. */
  readonly rewrittenDuplicateIds: number;
  /** Tool calls that carried no id and were given a synthetic one. */
  readonly assignedBlankIds: number;
  /**
   * Provenance for every output row, composed across BOTH repair steps:
   * `messages[k]` came from `input[sourceMessageIndexes[k]]`, or is a synthetic
   * placeholder when the entry is `null`. Same length as `messages`.
   *
   * A caller that needs to carry its own per-row data through the repair (the
   * compaction corpus carries DB row ids and canonical tool arguments) resolves
   * it through this, because an id rewrite means object identity no longer
   * links an output row to its input.
   */
  readonly sourceMessageIndexes: readonly (number | null)[];
}

/**
 * Make the tape legal for every chat-completions provider: unique, non-blank
 * tool-call ids first, then a synthetic result for every call still unanswered.
 *
 * Returns a new array; the input is not mutated. Idempotent — running on an
 * already-repaired array is a no-op.
 */
export function repairOrphanedToolCalls(
  messages: readonly ProviderMessage[],
): RepairOutcome {
  // Ids first: the orphan walk below matches calls to results BY id, so it
  // cannot reason about a tape where one id means two different calls.
  const normalized = normalizeToolCallIds(messages);
  const source = normalized.messages;

  const result: ProviderMessage[] = [];
  const sourceMessageIndexes: (number | null)[] = [];
  let inserted = 0;

  for (let i = 0; i < source.length; i++) {
    const msg = source[i];
    result.push(msg);
    sourceMessageIndexes.push(i);

    if (msg.role !== "assistant") continue;
    const calls = msg.toolCalls;
    if (!calls || calls.length === 0) continue;

    // Normalization guarantees non-blank ids; the filter stays as a defence
    // for callers that reach this walk with a hand-built array.
    const wantedIds: string[] = [];
    for (const c of calls) {
      if (typeof c.id === "string" && c.id.length > 0) wantedIds.push(c.id);
    }
    if (wantedIds.length === 0) continue;
    const wanted = new Set(wantedIds);

    // Walk forward over the contiguous run of `role:"tool"` messages that
    // immediately follows. Stop at the first non-tool row — anything past
    // that point cannot count as adjacent and the validators will reject.
    const matched = new Set<string>();
    let j = i + 1;
    while (j < source.length && source[j].role === "tool") {
      const id = source[j].toolCallId;
      if (typeof id === "string" && wanted.has(id)) matched.add(id);
      result.push(source[j]);
      sourceMessageIndexes.push(j);
      j += 1;
    }
    i = j - 1; // resume the outer loop after the consumed tool run

    // Synthesize placeholders for any wanted id that didn't land. The
    // placeholders go right after the contiguous matched run so the strict
    // assistant → tool adjacency stays intact.
    for (const id of wantedIds) {
      if (matched.has(id)) continue;
      result.push({
        role: "tool",
        content: TOOL_RESULT_PLACEHOLDER_CONTENT,
        toolCallId: id,
      });
      sourceMessageIndexes.push(null);
      inserted += 1;
    }
  }

  if (normalized.rewrittenDuplicateIds > 0 || normalized.assignedBlankIds > 0) {
    // Counts only — a tool-call id is opaque provider data and its arguments
    // carry addresses and amounts (rule 06).
    logger.warn("engine.transcript.tool_ids_normalized", {
      rewrittenDuplicateIds: normalized.rewrittenDuplicateIds,
      assignedBlankIds: normalized.assignedBlankIds,
    });
  }

  return {
    messages: result,
    insertedPlaceholders: inserted,
    rewrittenDuplicateIds: normalized.rewrittenDuplicateIds,
    assignedBlankIds: normalized.assignedBlankIds,
    sourceMessageIndexes,
  };
}
